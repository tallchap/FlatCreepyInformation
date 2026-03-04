#!/usr/bin/env node
import { BigQuery } from "@google-cloud/bigquery";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";

const MAX_ATTEMPTS = 2;
const ATTEMPT_DELAY_MS = 15000;
const VIDEO_DELAY_MS = 15000;
const MIN_SEGMENTS_PER_MIN = 1;

const START_AFTER_ID = "HTAtQ0-eRl8";
const FAILED_EVER_IDS = [
  "-0BQwHiEPOA","-LR0NdW4J1M","0BZz9SFTdvo","0UoefNE9-pM","0VL9LqRrQug",
  "12OiRxEuxPM","1XghbQcLwPo","1lFVRqOammw","1yA-TYh5Fe0","2BZFhDWJ8D8",
  "2C-A797y8dA","2M2WwFuIn5s","2N5ArZaQkAE","2WiPx6thH2E","2bXn2F58OsM",
  "2cNLh1gfQIk","3AmFAWqV2l0","3KwAIdK9J1A","3bHxduONnyo","3xEtVv3Z4tc",
  "41Ks1wG5CT8","4GLSzuYXh6w","4YnIGUlP9E0","4Zrl8UIrlqc","4a6ZC70Gkgg",
  "4ppTSkXRU0E","5B06ugw1K2g","5CUJExj5yVE","5QNZL8WEWu0","5uooRe07mYM",
  "6Mg9FFA8qdQ","6Ouas2qAjfw","6RUR6an5hOY","6jCKRw1xx2M","6n6aqOsqtYc",
  "6osJYjs1TRE","6wDc6tFjfZI","7ElmaEV3aJI","7HSZw794rKw","7PawjFKwmMg",
  "8-Ymdc6EdKw","84dVT0EFZj8","88nKI-qqWEo","8Bdg0J7-7uI","8Ga9aGom5Y8",
  "8PvtjHZQpHg","8QpXh48tRa4","8hR32QyUrBw","8jQKRyZepJ0","96zNGsFpeKU",
  "9BBK968xOhM","9XcHGEIky5o","9ajwtKWH8ng","9dw308Ljzd4","9noYcKjfyb8",
  "A71lfXrQlxU","AEHASTdzeAU","AMnKOrJLMdg","Aci0oIkUQ50","AnQBeLJspVQ",
  "Ay2m_AAoirQ","BZf-z1hZPG8","BkQaqEo4nAk","BqvBhhTtUm4","BxGyV2548xs",
  "BxkVmLPq79k","C0QTXU1GBmQ","Cf_l6LNiXGI","ChyijXdnR9g","D07w4finekw",
  "D8mgXMJk578","Dc2iGFD8JHo","DokLw1tILlw","EMnBKfHKy5E","Edslp56WaFw",
  "EmIXicxf8wY","F3l2XMMfByk","FBUdwtoOb3U","FSgVCHDacuU","FaH7v6tu6_0",
  "FtWZMIvjPwQ","Fv7a4Rp_EJ4","G1GVi-Amgx4","GAbCwqzprqs","GO7StahYBWI",
  "Gvx2Jv1VTIs","Gwad1cWMcC0","GzUUghxDhYM","HL_nbOpn3mU","HLi6wOa1-Q4",
  "HMJdudwHZQ8","HNrUOcDIYZU","HO7oYuqqnjA","HPOxCHhCJFA","HQ8VLOYbx-I",
  "HQV9s_JgNZA","HTAtQ0-eRl8"
];

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

function passesCheckpoint({ segmentCount, maxStart }) {
  const minutes = Number.isFinite(maxStart) && maxStart > 0 ? maxStart / 60 : 0;
  const segmentsPerMin = minutes > 0 ? segmentCount / minutes : 0;
  return {
    pass: segmentsPerMin >= MIN_SEGMENTS_PER_MIN,
    segmentsPerMin,
  };
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
        AND s.ID > @startAfter
        AND s.ID NOT IN UNNEST(@failedEverIds)
      ORDER BY s.ID ASC
      LIMIT 20
    `,
    params: { startAfter: START_AFTER_ID, failedEverIds: FAILED_EVER_IDS },
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
        const gate = passesCheckpoint(shaped);
        const ok = gate.pass;

        attemptLogs.push({
          attempt,
          ok,
          segmentCount: shaped.segmentCount,
          minStart: shaped.minStart,
          maxStart: shaped.maxStart,
          segmentsPerMin: gate.segmentsPerMin,
          reason: ok ? "pass" : "checkpoint_fail",
        });

        if (!ok) {
          if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, ATTEMPT_DELAY_MS));
          continue;
        }

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
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, ATTEMPT_DELAY_MS));
        }
      }
    }

    if (!passed) process.stdout.write(`FAIL after ${MAX_ATTEMPTS}\n`);

    results.push({
      videoId,
      status: passed ? "success" : "failed",
      attempts: attemptLogs,
    });

    await new Promise((r) => setTimeout(r, VIDEO_DELAY_MS));
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

  const outPath = path.resolve(process.cwd(), "scripts/retranscribe-next20-15s-unfailed-ever.results.json");
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));


  const failedItems = results
    .filter((r) => r.status === "failed")
    .map((r) => {
      const last = r.attempts[r.attempts.length - 1] || {};
      return {
        id: r.videoId,
        youtubeLink: `https://www.youtube.com/watch?v=${r.videoId}`,
        failureCode: last.reason || "failed",
        lastReason: last.reason || "failed",
        lastError: last.error || null,
        attempts: r.attempts.length,
      };
    });

  const failedPath = path.resolve(process.cwd(), "src/data/failed-transcripts.json");
  try {
    const existing = fs.existsSync(failedPath) ? JSON.parse(fs.readFileSync(failedPath, "utf8")) : { items: [] };
    const map = new Map((existing.items || []).map((x) => [x.id, x]));
    for (const item of failedItems) map.set(item.id, item);
    const merged = {
      generatedAt: new Date().toISOString(),
      source: "scripts/retranscribe-next20-15s-unfailed-ever.results.json",
      count: map.size,
      items: Array.from(map.values()).sort((a,b)=>a.id.localeCompare(b.id)),
    };
    fs.writeFileSync(failedPath, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error("Failed to update failed-transcripts.json", e?.message || e);
  }

  console.log("\n=== BATCH SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Detailed results written to: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
