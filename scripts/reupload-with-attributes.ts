#!/usr/bin/env npx tsx
/**
 * Re-upload transcript files to OpenAI vector stores with metadata attributes.
 *
 * Usage:
 *   npx tsx scripts/reupload-with-attributes.ts --dry-run   # Preview changes
 *   npx tsx scripts/reupload-with-attributes.ts              # Execute migration
 *
 * Requires env vars:
 *   OPENAI_API_KEY
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON
 */

import OpenAI from "openai";
import { BigQuery } from "@google-cloud/bigquery";
import * as fs from "fs";
import * as path from "path";

// ── Config ──────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseServiceAccount(raw: string | undefined) {
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        const fixed = raw.replace(
            /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
            (_m, key) =>
                `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
        );
        return JSON.parse(fixed);
    }
}

const credentials = parseServiceAccount(
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
);
const bigQuery = new BigQuery({
    credentials,
    projectId: credentials.project_id,
});

// ── Load citation map ───────────────────────────────────────────────────

const citationMapPath = path.resolve(
    __dirname,
    "../src/lib/file-citation-map.json",
);
const citationMap = JSON.parse(fs.readFileSync(citationMapPath, "utf-8")) as Record<
    string,
    {
        vectorStoreId: string;
        files: Record<string, { videoId: string; title: string }>;
    }
>;

// ── Fetch metadata from BigQuery ────────────────────────────────────────

interface VideoMeta {
    channel: string | null;
    published_date: string | null;
    published_year: number | null;
    duration_sec: number | null;
    speakers: string | null;
}

async function fetchVideoMetadata(videoId: string): Promise<VideoMeta | null> {
    // Try new tables first
    const [rows] = await bigQuery.query({
        query: `
      SELECT
        channel_name AS channel,
        CAST(published_date AS STRING) AS published_date,
        EXTRACT(YEAR FROM published_date) AS published_year,
        video_length,
        speaker_source AS speakers
      FROM \`youtubetranscripts-429803.reptranscripts.youtube_videos\`
      WHERE video_id = @videoId
      LIMIT 1
    `,
        params: { videoId },
    });

    if (rows.length > 0) {
        const r = rows[0] as any;
        return {
            channel: r.channel || null,
            published_date: r.published_date || null,
            published_year: r.published_year ? Number(r.published_year) : null,
            duration_sec: parseDuration(r.video_length),
            speakers: r.speakers || null,
        };
    }

    // Fallback to legacy table
    const [legacyRows] = await bigQuery.query({
        query: `
      SELECT
        Channel_Name AS channel,
        CAST(Published_Date AS STRING) AS published_date,
        EXTRACT(YEAR FROM Published_Date) AS published_year,
        Video_Length AS video_length,
        COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS speakers
      FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
      WHERE ID = @videoId
      LIMIT 1
    `,
        params: { videoId },
    });

    if (legacyRows.length > 0) {
        const r = legacyRows[0] as any;
        return {
            channel: r.channel || null,
            published_date: r.published_date || null,
            published_year: r.published_year ? Number(r.published_year) : null,
            duration_sec: parseDuration(r.video_length),
            speakers: r.speakers || null,
        };
    }

    return null;
}

function parseDuration(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const parts = raw
        .split(":")
        .map((p) => Number(p.trim()))
        .filter((n) => Number.isFinite(n));
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
}

// ── Main migration ──────────────────────────────────────────────────────

interface MigrationResult {
    speaker: string;
    fileId: string;
    videoId: string;
    title: string;
    status: "ok" | "skipped" | "error";
    error?: string;
    attributes?: Record<string, string | number>;
}

async function migrateFile(
    vectorStoreId: string,
    fileId: string,
    videoId: string,
    title: string,
    speaker: string,
): Promise<MigrationResult> {
    const base: MigrationResult = { speaker, fileId, videoId, title, status: "ok" };

    try {
        const meta = await fetchVideoMetadata(videoId);

        const attributes: Record<string, string | number> = {
            speaker,
            video_id: videoId,
            title: title.slice(0, 512), // 512 char limit
        };

        if (meta?.channel) attributes.channel = meta.channel.slice(0, 512);
        if (meta?.published_date) attributes.published_date = meta.published_date;
        if (meta?.published_year) attributes.published_year = meta.published_year;
        if (meta?.duration_sec) attributes.duration_sec = meta.duration_sec;

        // Add individual speaker attributes (speaker_1 through speaker_5)
        if (meta?.speakers) {
            const speakerList = meta.speakers.split(",").map(s => s.trim()).filter(Boolean);
            for (let i = 0; i < Math.min(speakerList.length, 5); i++) {
                attributes[`speaker_${i + 1}`] = speakerList[i].slice(0, 512);
            }
        }

        base.attributes = attributes;

        if (DRY_RUN) {
            console.log(`  [DRY RUN] ${videoId} → ${Object.keys(attributes).length} attributes`);
            return base;
        }

        // Update file attributes on the vector store
        // The OpenAI API allows updating file attributes without re-uploading
        await openai.vectorStores.files.update(vectorStoreId, fileId, {
            attributes,
        });

        console.log(`  ✅ ${videoId} — ${title.slice(0, 60)}`);
        return base;
    } catch (err: any) {
        const msg = err?.message || String(err);
        console.error(`  ❌ ${videoId} — ${msg}`);
        return { ...base, status: "error", error: msg };
    }
}

async function main() {
    console.log(`\n${"=".repeat(60)}`);
    console.log(DRY_RUN ? "  DRY RUN — no changes will be made" : "  LIVE RUN — updating file attributes");
    console.log(`${"=".repeat(60)}\n`);

    const results: MigrationResult[] = [];

    for (const [speakerSlug, speakerData] of Object.entries(citationMap)) {
        const speakerName = speakerSlug === "yudkowsky" ? "Eliezer Yudkowsky" : "Liron Shapira";
        const { vectorStoreId, files } = speakerData;
        const fileEntries = Object.entries(files);

        console.log(`\n📁 ${speakerName} — ${fileEntries.length} files in ${vectorStoreId}`);

        for (const [fileId, { videoId, title }] of fileEntries) {
            const result = await migrateFile(vectorStoreId, fileId, videoId, title, speakerName);
            results.push(result);
        }
    }

    // Summary
    const ok = results.filter((r) => r.status === "ok").length;
    const errors = results.filter((r) => r.status === "error");

    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Total: ${results.length} | Success: ${ok} | Errors: ${errors.length}`);
    if (errors.length > 0) {
        console.log(`\n  Failed files:`);
        for (const e of errors) {
            console.log(`    - ${e.videoId}: ${e.error}`);
        }
    }
    console.log(`${"=".repeat(60)}\n`);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
