#!/usr/bin/env npx tsx
/**
 * Upload ALL transcripts to a single shared OpenAI vector store.
 * One file per speaker per video (duplicated for each speaker on multi-speaker videos).
 *
 * Usage:
 *   npx tsx scripts/upload-all-transcripts.ts --dry-run              # Preview
 *   npx tsx scripts/upload-all-transcripts.ts --limit 100            # First 100 speakers
 *   npx tsx scripts/upload-all-transcripts.ts --store vs_existing    # Resume into existing store
 *   npx tsx scripts/upload-all-transcripts.ts                        # Full run
 *
 * Requires env vars: OPENAI_API_KEY, GOOGLE_APPLICATION_CREDENTIALS_JSON
 */

import * as path from "path";
import { config } from "dotenv";

// Load env — try local .env.local first, then snippysaurus-live
config({ path: path.resolve(__dirname, "../.env.local") });
if (!process.env.OPENAI_API_KEY) {
  config({ path: path.resolve(__dirname, "../../snippysaurus-live/.env.local") });
}

import OpenAI from "openai";
import { BigQuery } from "@google-cloud/bigquery";
import * as fs from "fs";

// ── Config ──────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_FLAG = process.argv.indexOf("--limit");
const SPEAKER_LIMIT = LIMIT_FLAG >= 0 ? Number(process.argv[LIMIT_FLAG + 1]) : Infinity;
const OFFSET_FLAG = process.argv.indexOf("--offset");
const SPEAKER_OFFSET = OFFSET_FLAG >= 0 ? Number(process.argv[OFFSET_FLAG + 1]) : 0;
const STORE_FLAG = process.argv.indexOf("--store");
const EXISTING_STORE_ID = STORE_FLAG >= 0 ? process.argv[STORE_FLAG + 1] : null;

// ── Clients ─────────────────────────────────────────────────────────────

function parseServiceAccount(raw: string | undefined) {
  if (!raw) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON not set");
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

const credentials = parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
const bigQuery = new BigQuery({ credentials, projectId: credentials.project_id });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Tables ──────────────────────────────────────────────────────────────

const VIDEOS_TABLE = "`youtubetranscripts-429803.reptranscripts.youtube_videos`";
const SEGMENTS_TABLE = "`youtubetranscripts-429803.reptranscripts.youtube_transcript_segments`";
const LEGACY_TABLE = "`youtubetranscripts-429803.reptranscripts.youtube_transcripts`";

// ── Helpers ─────────────────────────────────────────────────────────────

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function slugify(name: string): string {
  return stripDiacritics(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseDuration(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parts = raw.split(":").map((p) => Number(p.trim())).filter((n) => Number.isFinite(n));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

// ── Data types ──────────────────────────────────────────────────────────

interface VideoRow {
  video_id: string;
  video_title: string;
  channel_name: string;
  published_date: string | null;
  video_length: string | null;
  speaker_source: string;
  language_code: string | null;
}

interface TranscriptSegment {
  start_sec: number | null;
  text: string;
}

// ── BigQuery queries ────────────────────────────────────────────────────

async function fetchAllSpeakersAlpha(limit: number, offset: number): Promise<string[]> {
  const [rows] = await bigQuery.query({
    query: `
      SELECT TRIM(speaker) AS name
      FROM ${VIDEOS_TABLE}, UNNEST(SPLIT(speaker_source, ",")) AS speaker
      WHERE TRIM(speaker) != ""
      GROUP BY name
      ORDER BY name ASC
      ${limit < Infinity ? `LIMIT ${limit + offset}` : ""}
    `,
  });
  const all = rows.map((r: any) => String(r.name));
  return offset > 0 ? all.slice(offset) : all;
}

async function fetchVideosForSpeakers(speakers: string[]): Promise<VideoRow[]> {
  const [rows] = await bigQuery.query({
    query: `
      SELECT DISTINCT
        v.video_id,
        v.video_title,
        v.channel_name,
        CAST(v.published_date AS STRING) AS published_date,
        v.video_length,
        v.speaker_source,
        l.Language_Code AS language_code
      FROM ${VIDEOS_TABLE} v
      LEFT JOIN ${LEGACY_TABLE} l ON l.ID = v.video_id
      WHERE EXISTS (
        SELECT 1 FROM UNNEST(SPLIT(v.speaker_source, ",")) AS s
        WHERE TRIM(s) IN UNNEST(@speakers)
      )
    `,
    params: { speakers },
  });
  return rows as VideoRow[];
}

async function fetchTranscriptSegments(videoId: string): Promise<TranscriptSegment[]> {
  // Try new table first
  const [rows] = await bigQuery.query({
    query: `
      SELECT start_sec, text
      FROM ${SEGMENTS_TABLE}
      WHERE video_id = @videoId
      ORDER BY COALESCE(start_sec, 1e12), segment_index
    `,
    params: { videoId },
  });

  if (rows.length > 0) {
    return rows.map((r: any) => ({
      start_sec: r.start_sec == null ? null : Number(r.start_sec),
      text: String(r.text ?? ""),
    }));
  }

  // Fallback to legacy table
  const [legacyRows] = await bigQuery.query({
    query: `SELECT Search_Doc_1 FROM ${LEGACY_TABLE} WHERE ID = @videoId LIMIT 1`,
    params: { videoId },
  });

  if (legacyRows.length > 0 && legacyRows[0].Search_Doc_1) {
    return [{ start_sec: null, text: String(legacyRows[0].Search_Doc_1) }];
  }

  return [];
}

function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.start_sec == null) return seg.text;
      const m = Math.floor(seg.start_sec / 60);
      const s = Math.floor(seg.start_sec % 60);
      return `[${m}:${String(s).padStart(2, "0")}] ${seg.text}`;
    })
    .join("\n");
}

// ── Upload ──────────────────────────────────────────────────────────────

async function uploadFile(
  videoId: string,
  speakerSlug: string,
  title: string,
  date: string,
  transcript: string,
): Promise<OpenAI.FileObject> {
  const content = `VIDEO_ID: ${videoId}
Title: ${title}
Date: ${date || "Unknown"}
URL: https://youtu.be/${videoId}
${"─".repeat(37)}
${transcript}
${"─".repeat(37)}
END OF TRANSCRIPT — Video ID: ${videoId} — Title: ${title}`;

  const tmpPath = `/tmp/transcript_${videoId}_${speakerSlug}.txt`;
  fs.writeFileSync(tmpPath, content);

  const file = await openai.files.create({
    file: fs.createReadStream(tmpPath),
    purpose: "assistants",
  });

  fs.unlinkSync(tmpPath);
  return file;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(DRY_RUN ? "  DRY RUN — no files will be uploaded" : "  LIVE RUN — uploading to OpenAI");
  console.log(`  Speaker offset: ${SPEAKER_OFFSET}, limit: ${SPEAKER_LIMIT < Infinity ? SPEAKER_LIMIT : "ALL"}`);
  if (EXISTING_STORE_ID) console.log(`  Resuming into store: ${EXISTING_STORE_ID}`);
  console.log(`${"=".repeat(60)}\n`);

  // 1. Get speakers
  console.log("Fetching speakers...");
  const speakers = await fetchAllSpeakersAlpha(SPEAKER_LIMIT, SPEAKER_OFFSET);
  console.log(`Found ${speakers.length} speakers`);

  // 2. Fetch all videos for these speakers
  console.log("Fetching videos...");
  const videos = await fetchVideosForSpeakers(speakers);
  console.log(`Found ${videos.length} unique videos`);

  // 3. Build the file list: one entry per speaker per video
  interface FileEntry {
    videoId: string;
    speaker: string;
    speakerSlug: string;
    title: string;
    channel: string;
    publishedDate: string | null;
    publishedYear: number | null;
    durationSec: number | null;
    language: string;
    coSpeakers: string[]; // other speakers on this video, excluding this speaker
  }

  const speakerSet = new Set(speakers);
  const fileEntries: FileEntry[] = [];

  for (const video of videos) {
    const allSpeakers = video.speaker_source
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Only create entries for speakers in our target set
    const targetSpeakers = allSpeakers.filter((s) => speakerSet.has(s));

    for (const speaker of targetSpeakers) {
      const others = allSpeakers
        .filter((s) => s !== speaker)
        .map(stripDiacritics)
        .sort();

      fileEntries.push({
        videoId: video.video_id,
        speaker,
        speakerSlug: slugify(speaker),
        title: video.video_title,
        channel: video.channel_name,
        publishedDate: video.published_date || null,
        publishedYear: video.published_date ? Number(video.published_date.split("-")[0]) : null,
        durationSec: parseDuration(video.video_length),
        language: video.language_code || "en",
        coSpeakers: others,
      });
    }
  }

  console.log(`Total files to upload: ${fileEntries.length}`);

  if (DRY_RUN) {
    // Show summary and sample
    const bySpeaker = new Map<string, number>();
    for (const e of fileEntries) {
      bySpeaker.set(e.speaker, (bySpeaker.get(e.speaker) || 0) + 1);
    }
    console.log(`\nFiles per speaker (sample):`);
    let count = 0;
    for (const [name, num] of [...bySpeaker.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${name}: ${num} files`);
      if (++count >= 20) {
        console.log(`  ... and ${bySpeaker.size - 20} more speakers`);
        break;
      }
    }

    console.log(`\nSample file entry:`);
    const sample = fileEntries[0];
    console.log(JSON.stringify({
      filename: `transcript_${sample.videoId}_${sample.speakerSlug}.txt`,
      attributes: {
        video_id: sample.videoId,
        speaker: stripDiacritics(sample.speaker),
        title: sample.title.slice(0, 60) + "...",
        channel: sample.channel,
        published_date: sample.publishedDate,
        published_year: sample.publishedYear,
        duration_sec: sample.durationSec,
        language: sample.language,
        co_speaker_1: sample.coSpeakers[0] || "",
        co_speaker_2: sample.coSpeakers[1] || "",
        co_speaker_3: sample.coSpeakers[2] || "",
      },
    }, null, 2));

    console.log("\nDry run complete. Run without --dry-run to upload.");
    return;
  }

  // 4. Create or reuse vector store
  let vectorStoreId: string;
  if (EXISTING_STORE_ID) {
    vectorStoreId = EXISTING_STORE_ID;
    console.log(`Using existing vector store: ${vectorStoreId}`);
  } else {
    console.log("Creating shared vector store...");
    const store = await openai.vectorStores.create({
      name: "All Speakers - Shared Transcripts",
    });
    vectorStoreId = store.id;
    console.log(`Created vector store: ${vectorStoreId}`);
  }

  // 5. Fetch transcripts and upload files
  // Cache transcripts since multiple speakers share the same video
  const transcriptCache = new Map<string, string>();
  const uploadedFiles: { fileId: string; entry: FileEntry }[] = [];
  const errors: { entry: FileEntry; error: string }[] = [];

  for (let i = 0; i < fileEntries.length; i++) {
    const entry = fileEntries[i];

    // Get or fetch transcript
    let transcript = transcriptCache.get(entry.videoId);
    if (!transcript) {
      const segments = await fetchTranscriptSegments(entry.videoId);
      if (segments.length === 0) {
        console.log(`  [${i + 1}/${fileEntries.length}] SKIP (no transcript): ${entry.videoId}`);
        errors.push({ entry, error: "no transcript" });
        continue;
      }
      transcript = formatTranscript(segments);
      if (transcript.length < 100) {
        console.log(`  [${i + 1}/${fileEntries.length}] SKIP (too short): ${entry.videoId}`);
        errors.push({ entry, error: "transcript too short" });
        continue;
      }
      transcriptCache.set(entry.videoId, transcript);
    }

    const dateStr = entry.publishedDate || "Unknown";

    try {
      const file = await uploadFile(
        entry.videoId,
        entry.speakerSlug,
        entry.title,
        dateStr,
        transcript,
      );

      uploadedFiles.push({ fileId: file.id, entry });

      console.log(
        `  [${i + 1}/${fileEntries.length}] ${entry.speaker} | ${entry.videoId} | ${entry.title.slice(0, 50)}...`,
      );

      // Rate limit pause every 10 uploads
      if ((i + 1) % 10 === 0) {
        console.log("  (pausing 2s for rate limits...)");
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error(`  ERROR [${i + 1}] ${entry.videoId} (${entry.speaker}): ${msg}`);
      errors.push({ entry, error: msg });
    }
  }

  console.log(`\nUploaded ${uploadedFiles.length} files. Errors: ${errors.length}`);

  // 6. Add files to vector store in batches of 50
  console.log("\nAdding files to vector store in batches...");
  const allFileIds = uploadedFiles.map((f) => f.fileId);
  const batchSize = 50;

  for (let i = 0; i < allFileIds.length; i += batchSize) {
    const batch = allFileIds.slice(i, i + batchSize);
    console.log(`  Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allFileIds.length / batchSize)} (${batch.length} files)...`);
    await openai.vectorStores.fileBatches.createAndPoll(vectorStoreId, {
      file_ids: batch,
    });
  }

  console.log("All files added to vector store.");

  // 7. Set attributes on each file
  console.log("\nSetting metadata attributes...");
  let attrOk = 0;
  let attrErr = 0;

  for (let i = 0; i < uploadedFiles.length; i++) {
    const { fileId, entry } = uploadedFiles[i];

    const attributes: Record<string, string | number> = {
      video_id: entry.videoId,
      speaker: stripDiacritics(entry.speaker),
      title: entry.title.slice(0, 512),
      channel: (entry.channel || "").slice(0, 512),
      language: entry.language,
    };

    if (entry.publishedDate) attributes.published_date = entry.publishedDate;
    if (entry.publishedYear) attributes.published_year = entry.publishedYear;
    if (entry.durationSec) attributes.duration_sec = entry.durationSec;

    // Co-speakers (first 3 alphabetically, diacritics stripped)
    for (let j = 0; j < Math.min(entry.coSpeakers.length, 3); j++) {
      attributes[`co_speaker_${j + 1}`] = entry.coSpeakers[j].slice(0, 512);
    }

    try {
      await openai.vectorStores.files.update(vectorStoreId, fileId, { attributes });
      attrOk++;

      if ((i + 1) % 50 === 0) {
        console.log(`  Attributes set: ${i + 1}/${uploadedFiles.length}`);
      }
    } catch (err: any) {
      attrErr++;
      console.error(`  Attribute error ${entry.videoId}: ${err?.message}`);
    }
  }

  console.log(`Attributes: ${attrOk} ok, ${attrErr} errors`);

  // 8. Save citation map (merge with existing)
  const outPath = path.resolve(__dirname, "../src/lib/shared-store-citation-map.json");
  let existingFiles: Record<string, { videoId: string; speaker: string; title: string }> = {};
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    existingFiles = existing.files || {};
  } catch { /* no existing file */ }

  for (const { fileId, entry } of uploadedFiles) {
    existingFiles[fileId] = {
      videoId: entry.videoId,
      speaker: entry.speaker,
      title: entry.title,
    };
  }

  fs.writeFileSync(outPath, JSON.stringify({ vectorStoreId, files: existingFiles }, null, 2));

  // 9. Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Vector Store ID: ${vectorStoreId}`);
  console.log(`  Files uploaded:  ${uploadedFiles.length}`);
  console.log(`  Errors:          ${errors.length}`);
  console.log(`  Citation map:    ${outPath}`);
  console.log(`${"=".repeat(60)}\n`);

  if (errors.length > 0) {
    console.log("Errors:");
    for (const e of errors.slice(0, 20)) {
      console.log(`  ${e.entry.videoId} (${e.entry.speaker}): ${e.error}`);
    }
    if (errors.length > 20) console.log(`  ... and ${errors.length - 20} more`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
