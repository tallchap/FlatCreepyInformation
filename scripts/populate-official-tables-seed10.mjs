import { BigQuery } from "@google-cloud/bigquery";
import fs from "node:fs";
import path from "node:path";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseServiceAccount(raw) {
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

function parseSegments(raw) {
  if (!raw || typeof raw !== "string") return [];

  const rows = raw.trim().split(/\n+/);
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    const ln = rows[i]?.trim();
    if (!ln) continue;

    let m = ln.match(/^\[(\d+):(\d{2})(?::(\d{2}))?]\s*(.*)$/);
    if (m) {
      const [, a, b, c, txt] = m;
      const startSec = c ? +a * 3600 + +b * 60 + +c : +a * 60 + +b;
      out.push({ lineIndex: i, startSec, text: (txt || "").trim() });
      continue;
    }

    m = ln.match(/^(\d+(?:\.\d+)?):\s*(.*)$/);
    if (m) {
      const [, secRaw, txt] = m;
      out.push({ lineIndex: i, startSec: parseFloat(secRaw), text: (txt || "").trim() });
      continue;
    }

    out.push({ lineIndex: i, startSec: null, text: ln });
  }

  const timestamped = out.filter((x) => x.startSec !== null).sort((a, b) => a.startSec - b.startSec);
  const untimestamped = out.filter((x) => x.startSec === null).sort((a, b) => a.lineIndex - b.lineIndex);
  const merged = [...timestamped, ...untimestamped];

  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i];
    let endSec = null;
    if (cur.startSec !== null) {
      for (let j = i + 1; j < merged.length; j++) {
        if (merged[j].startSec !== null) {
          endSec = merged[j].startSec;
          break;
        }
      }
    }
    cur.endSec = endSec;
  }

  return merged;
}

async function ensureTables(bigQuery, projectId, datasetId) {
  const dataset = bigQuery.dataset(datasetId);

  const videosTable = dataset.table("youtube_videos");
  const segmentsTable = dataset.table("youtube_transcript_segments");

  const [videosExists] = await videosTable.exists();
  if (!videosExists) {
    await videosTable.create({
      schema: [
        { name: "video_id", type: "STRING", mode: "REQUIRED" },
        { name: "video_title", type: "STRING" },
        { name: "channel_name", type: "STRING" },
        { name: "published_date", type: "DATE" },
        { name: "youtube_link", type: "STRING" },
        { name: "video_length", type: "STRING" },
        { name: "speaker_source", type: "STRING" },
        { name: "created_time", type: "TIMESTAMP" },
      ],
      timePartitioning: { type: "DAY", field: "created_time" },
      clustering: { fields: ["video_id", "published_date", "channel_name"] },
      description: "Normalized video-level metadata for transcript corpus",
    });
    console.log(`Created ${datasetId}.youtube_videos`);
  }

  const [segmentsExists] = await segmentsTable.exists();
  if (!segmentsExists) {
    await segmentsTable.create({
      schema: [
        { name: "video_id", type: "STRING", mode: "REQUIRED" },
        { name: "segment_id", type: "STRING", mode: "REQUIRED" },
        { name: "segment_index", type: "INT64" },
        { name: "line_index", type: "INT64" },
        { name: "start_sec", type: "FLOAT64" },
        { name: "end_sec", type: "FLOAT64" },
        { name: "text", type: "STRING" },
        { name: "created_at", type: "TIMESTAMP" },
      ],
      timePartitioning: { type: "DAY", field: "created_at" },
      clustering: { fields: ["video_id", "segment_index"] },
      description: "Normalized transcript segments with explicit timing",
    });
    console.log(`Created ${datasetId}.youtube_transcript_segments`);
  }

  return { videosTable, segmentsTable };
}

async function main() {
  loadEnvLocal();
  const credentials = parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  const projectId = credentials.project_id;
  const datasetId = "reptranscripts";

  const bigQuery = new BigQuery({ credentials, projectId });
  const { videosTable, segmentsTable } = await ensureTables(bigQuery, projectId, datasetId);

  const [sampleRows] = await bigQuery.query({
    query: `
      SELECT
        ID,
        Video_Title,
        Channel_Name,
        Published_Date,
        Youtube_Link,
        Video_Length,
        COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS speaker_source,
        Created_Time,
        Search_Doc_1
      FROM \`${projectId}.${datasetId}.youtube_transcripts\`
      WHERE Search_Doc_1 IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (PARTITION BY ID ORDER BY Created_Time DESC) = 1
      ORDER BY RAND()
      LIMIT 10
    `,
  });

  if (!sampleRows.length) {
    console.log("No source rows found.");
    return;
  }

  const nowIso = new Date().toISOString();

  const videoRows = sampleRows.map((r) => {
    let created = nowIso;
    if (r.Created_Time) {
      const d = new Date(r.Created_Time);
      if (!Number.isNaN(d.getTime())) created = d.toISOString();
    }
    return {
      video_id: String(r.ID),
      video_title: r.Video_Title || null,
      channel_name: r.Channel_Name || null,
      published_date: r.Published_Date || null,
      youtube_link: r.Youtube_Link || null,
      video_length: r.Video_Length || null,
      speaker_source: r.speaker_source || null,
      created_time: created,
    };
  });

  // Upsert-ish behavior by deleting existing sampled ids first
  const sampledIds = [...new Set(videoRows.map((v) => v.video_id))];
  await bigQuery.query({
    query: `DELETE FROM \`${projectId}.${datasetId}.youtube_videos\` WHERE video_id IN UNNEST(@ids)`,
    params: { ids: sampledIds },
  });
  await bigQuery.query({
    query: `DELETE FROM \`${projectId}.${datasetId}.youtube_transcript_segments\` WHERE video_id IN UNNEST(@ids)`,
    params: { ids: sampledIds },
  });

  await videosTable.insert(videoRows, { ignoreUnknownValues: true });

  const segmentRows = [];
  for (const r of sampleRows) {
    const videoId = String(r.ID);
    const segments = parseSegments(r.Search_Doc_1);

    segments.forEach((seg, idx) => {
      segmentRows.push({
        video_id: videoId,
        segment_id: `${videoId}:${String(idx).padStart(5, "0")}`,
        segment_index: idx,
        line_index: seg.lineIndex,
        start_sec: seg.startSec,
        end_sec: seg.endSec,
        text: seg.text,
        created_at: nowIso,
      });
    });
  }

  const batchSize = 500;
  for (let i = 0; i < segmentRows.length; i += batchSize) {
    const batch = segmentRows.slice(i, i + batchSize);
    await segmentsTable.insert(batch, { ignoreUnknownValues: true });
  }

  console.log(
    `Populated ${datasetId}.youtube_videos with ${videoRows.length} rows and ${datasetId}.youtube_transcript_segments with ${segmentRows.length} rows for ${sampledIds.length} videos.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
