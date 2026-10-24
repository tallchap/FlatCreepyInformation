// One-off migration: youtube_videos.video_source ('bunny' | 'youtube').
// Existing rows are Bunny-backed; yt-only rows are written by /api/admin/add-video.
// Safe to re-run.
import { BigQuery } from "@google-cloud/bigquery";
import fs from "node:fs";

const env = Object.fromEntries(fs.readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); let v = l.slice(i + 1); if (v.startsWith('"')) v = v.slice(1, v.lastIndexOf('"')); return [l.slice(0, i), v]; }));
const raw = env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
let creds;
try { creds = JSON.parse(raw); } catch { creds = JSON.parse(raw.replace(/"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/, (_m, k) => `"private_key":"${k.replace(/\n/g, "\\n")}","client_email"`)); }
const bq = new BigQuery({ credentials: creds, projectId: creds.project_id });
const T = "`youtubetranscripts-429803.reptranscripts.youtube_videos`";

await bq.query({ query: `ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS video_source STRING OPTIONS(description="'bunny' (video file stored in Bunny) or 'youtube' (yt-only: edited on the embed, fetched from YouTube at export)")` });
const [job] = await bq.createQueryJob({ query: `UPDATE ${T} SET video_source = 'bunny' WHERE video_source IS NULL` });
await job.getQueryResults();
const [meta] = await job.getMetadata();
console.log("backfilled rows:", meta.statistics?.query?.numDmlAffectedRows);
const [rows] = await bq.query({ query: `SELECT video_source, COUNT(*) n FROM ${T} GROUP BY 1` });
console.log(rows);
