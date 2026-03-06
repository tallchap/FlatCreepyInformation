#!/usr/bin/env node
import { BigQuery } from "@google-cloud/bigquery";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_LIMIT = Number(process.env.LIMIT || 10);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 2);
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const KEEP_AUDIO = String(process.env.KEEP_AUDIO || "0") === "1";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 24 * 1024 * 1024);
const TARGET_CHUNK_BYTES = Number(process.env.TARGET_CHUNK_BYTES || 20 * 1024 * 1024);

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
      (_m, key) => `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
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

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function ffprobeDurationSeconds(filePath) {
  const { stdout } = await runCmd("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const n = Number(String(stdout || "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function downloadAudio(videoId, outDir) {
  const outTemplate = path.join(outDir, `${videoId}.%(ext)s`);
  const args = [
    "-f",
    "bestaudio/best",
    "--no-playlist",
    "--extract-audio",
    "--audio-format",
    "mp3",
  ];

  // Optional auth for private/age-gated videos.
  // Example:
  //   YTDLP_COOKIES_FROM_BROWSER=chrome
  //   YTDLP_COOKIES_FILE=/path/to/cookies.txt
  if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    args.push("--cookies-from-browser", String(process.env.YTDLP_COOKIES_FROM_BROWSER));
  } else if (process.env.YTDLP_COOKIES_FILE) {
    args.push("--cookies", String(process.env.YTDLP_COOKIES_FILE));
  }

  args.push("-o", outTemplate, `https://www.youtube.com/watch?v=${videoId}`);

  await runCmd("/Users/orilaptop/.pyenv/shims/yt-dlp", args);
  const exact = path.join(outDir, `${videoId}.mp3`);
  if (fs.existsSync(exact)) return exact;
  const candidate = fs.readdirSync(outDir).find((f) => f.startsWith(`${videoId}.`));
  if (!candidate) throw new Error(`audio file not found for ${videoId}`);
  return path.join(outDir, candidate);
}

async function normalizeAudioForAsr(inputPath, outDir, videoId) {
  const normalizedPath = path.join(outDir, `${videoId}.asr.mp3`);
  await runCmd("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "48k",
    normalizedPath,
  ]);
  return normalizedPath;
}

async function splitAudioIfNeeded(audioPath, outDir, videoId) {
  const size = fs.statSync(audioPath).size;
  if (size <= MAX_UPLOAD_BYTES) {
    return [{ path: audioPath, offsetSec: 0 }];
  }

  const durationSec = await ffprobeDurationSeconds(audioPath);
  if (!durationSec) throw new Error("Could not determine audio duration for chunking");

  const parts = Math.max(2, Math.ceil(size / TARGET_CHUNK_BYTES));
  const segmentTime = Math.max(60, Math.ceil(durationSec / parts));

  const chunkDir = path.join(outDir, `${videoId}.chunks`);
  fs.mkdirSync(chunkDir, { recursive: true });

  await runCmd("ffmpeg", [
    "-y",
    "-i",
    audioPath,
    "-f",
    "segment",
    "-segment_time",
    String(segmentTime),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "48k",
    "-ac",
    "1",
    "-ar",
    "16000",
    path.join(chunkDir, `${videoId}.part-%03d.mp3`),
  ]);

  const files = fs
    .readdirSync(chunkDir)
    .filter((f) => f.endsWith(".mp3"))
    .sort()
    .map((f) => path.join(chunkDir, f));

  if (!files.length) throw new Error("Chunking produced no files");

  const chunks = [];
  let offset = 0;
  for (const f of files) {
    const chunkSize = fs.statSync(f).size;
    if (chunkSize > MAX_UPLOAD_BYTES) {
      throw new Error(`Chunk still exceeds max upload size: ${path.basename(f)} (${chunkSize} bytes)`);
    }
    chunks.push({ path: f, offsetSec: offset });
    const d = (await ffprobeDurationSeconds(f)) || segmentTime;
    offset += d;
  }
  return chunks;
}

async function transcribeAudioFile(openai, filePath) {
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: process.env.ASR_MODEL || "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  return Array.isArray(resp?.segments)
    ? resp.segments.map((s) => ({
        start: Number(s.start),
        end: Number(s.end),
        text: String(s.text || "").trim(),
      }))
    : [];
}

async function transcribeAudio(openai, audioPath, outDir, videoId) {
  const chunks = await splitAudioIfNeeded(audioPath, outDir, videoId);
  const merged = [];
  for (const chunk of chunks) {
    const segs = await transcribeAudioFile(openai, chunk.path);
    for (const s of segs) {
      merged.push({
        start: Number.isFinite(s.start) ? s.start + chunk.offsetSec : null,
        end: Number.isFinite(s.end) ? s.end + chunk.offsetSec : null,
        text: s.text,
      });
    }
  }

  return merged.map((s, idx) => ({ idx, start: s.start, end: s.end, text: s.text }));
}

async function main() {
  loadEnvLocal();

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const inputResults = process.argv[2] || "scripts/retranscribe-remaining-249-3parallel-30s.results.json";
  const limit = Number(process.argv[3] || DEFAULT_LIMIT);

  const inputJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), inputResults), "utf8"));
  const failedIds = (inputJson?.summary?.failedIds || []).slice(0, limit);
  if (!failedIds.length) {
    console.log("No failed IDs found in input.");
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const audioDir = path.resolve(process.cwd(), `.tmp/audio-fallback/${runId}`);
  fs.mkdirSync(audioDir, { recursive: true });

  const credentials = parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "");
  const projectId = credentials.project_id;
  const dataset = "reptranscripts";

  const bq = new BigQuery({ credentials, projectId });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const [metaRows] = await bq.query({
    query: `
      WITH src AS (
        SELECT
          ID,
          Video_Title,
          Channel_Name,
          Published_Date,
          Youtube_Link,
          Video_Length,
          COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS speaker_source,
          ROW_NUMBER() OVER (PARTITION BY ID ORDER BY Created_Time DESC) rn
        FROM \`${projectId}.${dataset}.youtube_transcripts\`
        WHERE ID IN UNNEST(@ids)
      )
      SELECT * FROM src WHERE rn = 1
    `,
    params: { ids: failedIds },
  });

  const metaById = new Map(metaRows.map((r) => [String(r.ID), r]));
  const videosTable = bq.dataset(dataset).table("youtube_videos");
  const segmentsTable = bq.dataset(dataset).table("youtube_transcript_segments");

  const queue = [...failedIds];
  const results = [];

  async function worker() {
    while (queue.length) {
      const videoId = queue.shift();
      const meta = metaById.get(String(videoId)) || {};
      const youtubeLink = String(meta.Youtube_Link || `https://www.youtube.com/watch?v=${videoId}`);

      let lastError = null;
      let audioPath = null;
      let succeeded = false;
      let attempt = 0;

      while (attempt < MAX_RETRIES && !succeeded) {
        attempt += 1;
        try {
          process.stdout.write(`[${videoId}] attempt ${attempt}/${MAX_RETRIES}... `);

          const downloadedPath = await downloadAudio(videoId, audioDir);
          audioPath = await normalizeAudioForAsr(downloadedPath, audioDir, videoId);
          const segments = await transcribeAudio(openai, audioPath, audioDir, videoId);

          if (!segments.length) throw new Error("ASR returned 0 segments");

          const now = new Date().toISOString();

          await bq.query({
            query: `DELETE FROM \`${projectId}.${dataset}.youtube_videos\` WHERE video_id = @videoId`,
            params: { videoId },
          });
          await bq.query({
            query: `DELETE FROM \`${projectId}.${dataset}.youtube_transcript_segments\` WHERE video_id = @videoId`,
            params: { videoId },
          });

          await videosTable.insert(
            [
              {
                video_id: String(videoId),
                video_title: meta.Video_Title || null,
                channel_name: meta.Channel_Name || null,
                published_date: normalizeDate(meta.Published_Date),
                youtube_link: youtubeLink,
                video_length: meta.Video_Length || null,
                speaker_source: meta.speaker_source || null,
                created_time: now,
                transcript_source: "audio_fallback_asr",
                fallback_reason: "primary_failed",
              },
            ],
            { ignoreUnknownValues: true },
          );

          const segRows = segments.map((s) => ({
            video_id: String(videoId),
            segment_id: `${videoId}:${String(s.idx).padStart(5, "0")}`,
            segment_index: s.idx,
            line_index: s.idx,
            start_sec: Number.isFinite(s.start) ? s.start : null,
            end_sec: Number.isFinite(s.end) ? s.end : null,
            text: s.text,
            created_at: now,
            transcript_source: "audio_fallback_asr",
          }));

          const B = 500;
          for (let i = 0; i < segRows.length; i += B) {
            await segmentsTable.insert(segRows.slice(i, i + B), { ignoreUnknownValues: true });
          }

          results.push({
            videoId,
            status: "success",
            attempts: attempt,
            segments: segments.length,
            audioPath,
          });
          succeeded = true;
          process.stdout.write(`PASS (${segments.length} segs)\n`);
        } catch (err) {
          lastError = err?.message || String(err);
          process.stdout.write(`FAIL (${lastError})\n`);
        }
      }

      if (!succeeded) {
        results.push({
          videoId,
          status: "failed",
          attempts: attempt,
          error: lastError,
          audioPath,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker()));

  const summary = {
    batchSize: results.length,
    success: results.filter((r) => r.status === "success").length,
    failed: results.filter((r) => r.status === "failed").length,
    retriesPerVideo: MAX_RETRIES,
    audioDir,
    keepAudio: KEEP_AUDIO,
  };

  const outPath = path.resolve(process.cwd(), `scripts/retranscribe-audio-fallback-${runId}.results.json`);
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));

  if (!KEEP_AUDIO) {
    fs.rmSync(audioDir, { recursive: true, force: true });
  }

  console.log("\n=== AUDIO FALLBACK SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Detailed results written to: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
