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

    // Keep untimestamped line as null-start segment.
    out.push({ lineIndex: i, startSec: null, text: ln });
  }

  // Sort timestamped first by time, keep nulls after in original order.
  const timestamped = out.filter((x) => x.startSec !== null).sort((a, b) => a.startSec - b.startSec);
  const untimestamped = out.filter((x) => x.startSec === null).sort((a, b) => a.lineIndex - b.lineIndex);

  const merged = [...timestamped, ...untimestamped];

  // Derive endSec from next timestamped row.
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

async function main() {
  loadEnvLocal();

  const credentials = parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  const bigQuery = new BigQuery({ credentials, projectId: credentials.project_id });

  const datasetId = "reptranscripts";
  const sourceTable = "youtube_transcripts";
  const targetTable = "youtube_transcript_segments_sample10";

  const dataset = bigQuery.dataset(datasetId);
  const table = dataset.table(targetTable);

  const [exists] = await table.exists();
  if (!exists) {
    await table.create({
      schema: [
        { name: "video_id", type: "STRING", mode: "REQUIRED" },
        { name: "segment_id", type: "STRING", mode: "REQUIRED" },
        { name: "segment_index", type: "INT64" },
        { name: "line_index", type: "INT64" },
        { name: "start_sec", type: "FLOAT64" },
        { name: "end_sec", type: "FLOAT64" },
        { name: "text", type: "STRING" },
        { name: "published_date", type: "DATE" },
        { name: "channel_name", type: "STRING" },
        { name: "video_title", type: "STRING" },
        { name: "speaker_source", type: "STRING" },
        { name: "created_at", type: "TIMESTAMP" },
      ],
      timePartitioning: { type: "DAY", field: "created_at" },
      clustering: { fields: ["video_id", "published_date", "channel_name"] },
      description: "Sample structured transcript segments for 10 random videos",
    });
    console.log(`Created table: ${datasetId}.${targetTable}`);
  } else {
    console.log(`Table exists: ${datasetId}.${targetTable}`);
  }

  const [rows] = await bigQuery.query({
    query: `
      SELECT
        ID,
        Search_Doc_1,
        Published_Date,
        Channel_Name,
        Video_Title,
        COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS speaker_source
      FROM \`${credentials.project_id}.${datasetId}.${sourceTable}\`
      WHERE Search_Doc_1 IS NOT NULL
      ORDER BY RAND()
      LIMIT 10
    `,
  });

  if (!rows.length) {
    console.log("No rows found in source table.");
    return;
  }

  let inserts = [];
  let totalSegments = 0;

  for (const row of rows) {
    const videoId = String(row.ID);
    const segments = parseSegments(row.Search_Doc_1);

    segments.forEach((seg, idx) => {
      inserts.push({
        video_id: videoId,
        segment_id: `${videoId}:${String(idx).padStart(5, "0")}`,
        segment_index: idx,
        line_index: seg.lineIndex,
        start_sec: seg.startSec,
        end_sec: seg.endSec,
        text: seg.text,
        published_date: row.Published_Date || null,
        channel_name: row.Channel_Name || null,
        video_title: row.Video_Title || null,
        speaker_source: row.speaker_source || null,
        created_at: new Date().toISOString(),
      });
    });

    totalSegments += segments.length;
  }

  // BigQuery insert API row limit safety
  const batchSize = 500;
  for (let i = 0; i < inserts.length; i += batchSize) {
    const batch = inserts.slice(i, i + batchSize);
    await table.insert(batch, { ignoreUnknownValues: true });
  }

  console.log(`Inserted ${totalSegments} segments from ${rows.length} random videos into ${datasetId}.${targetTable}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
