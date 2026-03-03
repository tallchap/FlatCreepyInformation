#!/usr/bin/env node
import { BigQuery } from "@google-cloud/bigquery";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";

const MAX_ATTEMPTS = 5;
const MIN_START_THRESHOLD_SEC = 2;
const MIN_ENDSTATE_MAX_START_SEC = 300;
const MIN_ENDSTATE_SEGMENT_COUNT = 200;

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function parseServiceAccount(raw = "") {
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

function normalizeDate(input) {
  if (!input) return null;
  try {
    const d = new Date(input.value || input);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function shapeTranscript(videoId, transcriptData) {
  const rows = Array.isArray(transcriptData) ? transcriptData : [];
  const segments = rows.map((s, idx) => {
    const start = Number(s.start);
    const duration = Number(s.duration);
    const startSec = Number.isFinite(start) ? start : null;
    const endSec = Number.isFinite(start) && Number.isFinite(duration) ? start + duration : null;
    return {
      video_id: videoId,
      segment_id: `${videoId}:${String(idx).padStart(5, "0")}`,
      segment_index: idx,
      line_index: idx,
      start_sec: startSec,
      end_sec: endSec,
      text: String(s.text || "").trim(),
      created_at: new Date().toISOString(),
    };
  });

  const starts = segments.map((x) => x.start_sec).filter((x) => Number.isFinite(x));
  const minStart = starts.length ? Math.min(...starts) : null;
  const maxStart = starts.length ? Math.max(...starts) : null;

  return {
    segments,
    segmentCount: segments.length,
    minStart,
    maxStart,
  };
}

function passesCheckpoint({ segmentCount, minStart, maxStart }) {
  const minStartPass = Number.isFinite(minStart) && minStart <= MIN_START_THRESHOLD_SEC;
  const endStatePass =
    (Number.isFinite(maxStart) && maxStart >= MIN_ENDSTATE_MAX_START_SEC) ||
    segmentCount >= MIN_ENDSTATE_SEGMENT_COUNT;
  return minStartPass && endStatePass;
}

async function fetchTranscript(url) {
  const { data } = await axios.post(
    "https://youtube-transcript-data.replit.app/transcript",
    { url },
    { timeout: 60000 },
  );
  return data;
}

async function insertSegments(table, segments) {
  const batchSize = 500;
  for (let i = 0; i < segments.length; i += batchSize) {
    await table.insert(segments.slice(i, i + batchSize), { ignoreUnknownValues: true });
  }
}

async function main() {
  loadEnvLocal();

  const credentials = parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "");
  const projectId = credentials.project_id;
  const dataset = "reptranscripts";
  const bq = new BigQuery({ credentials, projectId });

  const [targets] = await bq.query({
    query: `
      WITH source_latest AS (
        SELECT
          ID,
          Video_Title,
          Channel_Name,
          Published_Date,
          Youtube_Link,
          Video_Length,
          COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS speaker_source,
          ROW_NUMBER() OVER (PARTITION BY ID ORDER BY Created_Time DESC) AS rn
        FROM \`${projectId}.${dataset}.youtube_transcripts\`
      ),
      done_ids AS (
        SELECT DISTINCT video_id AS id
        FROM \`${projectId}.${dataset}.youtube_videos\`
      )
      SELECT
        s.ID,
        s.Video_Title,
        s.Channel_Name,
        s.Published_Date,
        s.Youtube_Link,
        s.Video_Length,
        s.speaker_source
      FROM source_latest s
      LEFT JOIN done_ids d ON d.id = s.ID
      WHERE s.rn = 1
        AND s.ID IS NOT NULL
        AND TRIM(s.ID) != ''
        AND d.id IS NULL
      ORDER BY s.ID ASC
      LIMIT 100
    `,
  });

  if (!targets.length) {
    console.log("No eligible videos found (all already processed or no source data).");
    return;
  }

  const videosTable = bq.dataset(dataset).table("youtube_videos");
  const segmentsTable = bq.dataset(dataset).table("youtube_transcript_segments");

  const results = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const videoId = String(t.ID);
    const url = String(t.Youtube_Link || `https://www.youtube.com/watch?v=${videoId}`);

    process.stdout.write(`[${i + 1}/${targets.length}] ${videoId} ... `);

    let passed = false;
    const attemptLogs = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const data = await fetchTranscript(url);
        const shaped = shapeTranscript(videoId, data?.transcript_data);
        const ok = passesCheckpoint(shaped);

        attemptLogs.push({
          attempt,
          ok,
          segmentCount: shaped.segmentCount,
          minStart: shaped.minStart,
          maxStart: shaped.maxStart,
          reason: ok ? "pass" : "checkpoint_fail",
        });

        if (!ok) continue;

        const now = new Date().toISOString();

        await videosTable.insert(
          [
            {
              video_id: videoId,
              video_title: t.Video_Title || null,
              channel_name: t.Channel_Name || null,
              published_date: normalizeDate(t.Published_Date),
              youtube_link: url,
              video_length: t.Video_Length || null,
              speaker_source: t.speaker_source || null,
              created_time: now,
            },
          ],
          { ignoreUnknownValues: true },
        );

        const withRunTime = shaped.segments.map((s) => ({ ...s, created_at: now }));
        await insertSegments(segmentsTable, withRunTime);

        passed = true;
        process.stdout.write(`PASS on attempt ${attempt}\n`);
        break;
      } catch (err) {
        attemptLogs.push({
          attempt,
          ok: false,
          reason: "request_error",
          error: err?.message || String(err),
        });
      }
    }

    if (!passed) process.stdout.write(`FAIL after ${MAX_ATTEMPTS}\n`);

    results.push({
      videoId,
      status: passed ? "success" : "failed",
      attempts: attemptLogs,
    });

    await new Promise((r) => setTimeout(r, 250));
  }

  const success = results.filter((r) => r.status === "success").length;
  const failed = results.length - success;
  const successAfterRetry = results.filter(
    (r) => r.status === "success" && (r.attempts.find((a) => a.ok)?.attempt || 1) > 1,
  ).length;

  const failedIds = results.filter((r) => r.status === "failed").map((r) => r.videoId);

  const summary = {
    batchSize: results.length,
    success,
    successAfterRetry,
    failed,
    failedIds,
  };

  const outPath = path.resolve(process.cwd(), "scripts/retranscribe-first100-alpha.results.json");
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));

  console.log("\n=== BATCH SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Detailed results written to: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
