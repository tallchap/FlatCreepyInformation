#!/usr/bin/env node
import { BigQuery } from "@google-cloud/bigquery";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";

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

function transcriptToSegments(videoId, transcript) {
  const rows = Array.isArray(transcript?.transcript_data) ? transcript.transcript_data : [];
  return rows.map((s, idx) => {
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
}

async function fetchTranscript(cleanUrl) {
  const { data } = await axios.post(
    "https://youtube-transcript-data.replit.app/transcript",
    { url: cleanUrl },
    { timeout: 120000 },
  );
  return data;
}

async function main() {
  loadEnvLocal();
  const credentials = parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "");
  const projectId = credentials.project_id;
  const dataset = "reptranscripts";
  const bq = new BigQuery({ credentials, projectId });

  // Use the current seeded set (latest 10 in official videos table).
  const [seedRows] = await bq.query({
    query: `
      SELECT video_id
      FROM \`${projectId}.${dataset}.youtube_videos\`
      QUALIFY ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY created_time DESC) = 1
      ORDER BY created_time DESC
      LIMIT 10
    `,
  });

  const ids = seedRows.map((r) => String(r.video_id));
  if (!ids.length) {
    console.log("No seeded IDs found in youtube_videos.");
    return;
  }

  const [metaRows] = await bq.query({
    query: `
      SELECT
        ID,
        Video_Title,
        Channel_Name,
        Published_Date,
        Youtube_Link,
        Video_Length,
        COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS speaker_source,
        Created_Time
      FROM \`${projectId}.${dataset}.youtube_transcripts\`
      WHERE ID IN UNNEST(@ids)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY ID ORDER BY Created_Time DESC) = 1
    `,
    params: { ids },
  });

  const metaById = new Map(metaRows.map((r) => [String(r.ID), r]));

  const videoRows = [];
  const allSegments = [];
  const failures = [];

  for (const id of ids) {
    const m = metaById.get(id);
    if (!m) {
      failures.push({ id, error: "metadata not found in youtube_transcripts" });
      continue;
    }

    const cleanUrl = String(m.Youtube_Link || `https://www.youtube.com/watch?v=${id}`);
    process.stdout.write(`Retranscribing ${id} ... `);

    try {
      const transcript = await fetchTranscript(cleanUrl);
      const segments = transcriptToSegments(id, transcript);
      allSegments.push(...segments);

      videoRows.push({
        video_id: id,
        video_title: m.Video_Title || null,
        channel_name: m.Channel_Name || null,
        published_date: normalizeDate(m.Published_Date),
        youtube_link: cleanUrl,
        video_length: m.Video_Length || null,
        speaker_source: m.speaker_source || null,
        created_time: new Date().toISOString(),
      });

      console.log(`ok (${segments.length} segments)`);
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.log("failed");
      failures.push({ id, error: err?.message || String(err) });
    }
  }

  const okIds = videoRows.map((r) => r.video_id);
  if (okIds.length) {
    // Append-only writes to avoid BigQuery streaming-buffer DELETE limitations.
    // Consumers should select latest created_time/created_at per video_id.
    await bq.dataset(dataset).table("youtube_videos").insert(videoRows, { ignoreUnknownValues: true });

    const batchSize = 500;
    const table = bq.dataset(dataset).table("youtube_transcript_segments");
    for (let i = 0; i < allSegments.length; i += batchSize) {
      await table.insert(allSegments.slice(i, i + batchSize), { ignoreUnknownValues: true });
    }
  }

  console.log("\n=== RETRANSCRIBE SUMMARY ===");
  console.log(`Requested IDs: ${ids.length}`);
  console.log(`Succeeded: ${okIds.length}`);
  console.log(`Failed: ${failures.length}`);
  console.log(`Inserted video rows: ${videoRows.length}`);
  console.log(`Inserted segment rows: ${allSegments.length}`);

  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`- ${f.id}: ${f.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
