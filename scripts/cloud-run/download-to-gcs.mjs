import { Storage } from "@google-cloud/storage";
import { BigQuery } from "@google-cloud/bigquery";
import Redis from "ioredis";
import https from "https";
import { spawn } from "child_process";
import { unlinkSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const RAPIDAPI_KEY = (process.env.RAPIDAPI_KEY || "").trim();
const RAPIDAPI_HOST = "youtube-info-download-api.p.rapidapi.com";
const GCS_BUCKET = "snippysaurus-clips";
const GCS_PREFIX = "videos";
const RESULTS_PREFIX = "download-results";

const BUNNY_STREAM_API_KEY = (process.env.BUNNY_STREAM_API_KEY || "").trim();
const BUNNY_LIBRARY_ID = "627230";

const TASK_INDEX = parseInt(process.env.CLOUD_RUN_TASK_INDEX) || 0;
const TASK_COUNT = parseInt(process.env.CLOUD_RUN_TASK_COUNT) || 1;
const STATUS_PATH = TASK_COUNT > 1 ? `download-status/task-${TASK_INDEX}.json` : "download-status/current.json";

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 2;
const BATCH_OFFSET = parseInt(process.env.BATCH_OFFSET) || 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT) || 20;
const MODE = (process.env.MODE || "").trim(); // "bunny-only" → skip GCS, fetch RapidAPI URL direct to Bunny

// Redis-backed pipeline event log (admin dashboard).
const REDIS_URL = (process.env.REDIS_URL || "").trim();
let _redis = null;
if (REDIS_URL) {
  _redis = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
  _redis.on("error", (e) => console.log(`[pipeline-log] redis error: ${e.message}`));
}
async function logEvent({ videoId, pipeline, step, status, detail }) {
  if (!_redis) return;
  try {
    const payload = JSON.stringify({ ts: Date.now(), videoId, pipeline, step, status, detail });
    const videoKey = `pipeline:video:${videoId}`;
    await Promise.all([
      _redis.lpush("pipeline:events", payload),
      _redis.ltrim("pipeline:events", 0, 9999),
      _redis.lpush(videoKey, payload),
      _redis.ltrim(videoKey, 0, 99),
      _redis.expire(videoKey, 60 * 60 * 24 * 30),
      _redis.hset(`pipeline:latest:${videoId}`, { step, status, pipeline, ts: String(Date.now()) }),
      _redis.expire(`pipeline:latest:${videoId}`, 60 * 60 * 24 * 30),
    ]);
  } catch (e) {
    console.log(`[pipeline-log] logEvent failed: ${e.message}`);
  }
}

if (!RAPIDAPI_KEY) { console.error("Missing RAPIDAPI_KEY env var"); process.exit(1); }

const credJson = (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "").trim();
if (!credJson) { console.error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env var"); process.exit(1); }
let credentials;
try { credentials = JSON.parse(credJson); } catch {
  const fixed = credJson.replace(
    /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
    (_m, key) => `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
  );
  credentials = JSON.parse(fixed);
}
const storage = new Storage({ projectId: credentials.project_id, credentials });
const bucket = storage.bucket(GCS_BUCKET);
const bigquery = new BigQuery({ projectId: credentials.project_id, credentials });

// --- Helpers ---

// Poll Bunny for the given videoId's encoding status. Logs events at status
// transitions, progress milestones (every 20%), and when early-play / final
// HLS become ready. Caps at ~30 min.
const BUNNY_STATUS_LABEL = {
  0: "created", 1: "queued", 2: "processing", 3: "encoding",
  4: "ready", 5: "error", 6: "upload-failed",
};
async function pollBunnyUntilReady(videoId, pipelineName) {
  if (!BUNNY_STREAM_API_KEY) return;
  const startPoll = Date.now();
  const maxMs = 30 * 60 * 1000;
  const intervalMs = 10_000;
  let lastStatus = -1;
  let lastProgressBucket = -1;
  let loggedEarlyPlay = false;
  while (Date.now() - startPoll < maxMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let v;
    try {
      v = await new Promise((resolve, reject) => {
        https.get(
          `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?search=${encodeURIComponent(videoId)}&itemsPerPage=3`,
          { headers: { AccessKey: BUNNY_STREAM_API_KEY } },
          (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
          }
        ).on("error", reject);
      });
    } catch (e) {
      console.log(`  [${videoId}] Bunny poll error: ${e.message}`);
      continue;
    }
    const match = (v?.items || []).find((x) => x.title === videoId);
    if (!match) continue;
    const { status, encodeProgress, availableResolutions, width, height, guid } = match;
    const elapsedSec = Math.round((Date.now() - startPoll) / 1000);

    // Status transition events
    if (status !== lastStatus) {
      console.log(`  [${videoId}] Bunny status ${lastStatus}→${status} (${BUNNY_STATUS_LABEL[status] || status}) at ${elapsedSec}s`);
      await logEvent({
        videoId, pipeline: pipelineName,
        step: `bunny-status-${BUNNY_STATUS_LABEL[status] || status}`,
        status: status === 5 || status === 6 ? "error" : "info",
        detail: { bunnyStatus: status, encodeProgress, elapsedSec, guid },
      });
      lastStatus = status;
    }

    // Progress milestones — every 5% during status 2/3
    if ((status === 2 || status === 3) && typeof encodeProgress === "number") {
      const bucket = Math.floor(encodeProgress / 5) * 5;
      if (bucket > lastProgressBucket && bucket > 0) {
        lastProgressBucket = bucket;
        await logEvent({
          videoId, pipeline: pipelineName,
          step: "bunny-progress",
          status: "info",
          detail: { encodeProgress, bucket, availableResolutions, elapsedSec },
        });
      }
    }

    // Early-Play: once the first rendition is listed, it's playable
    if (!loggedEarlyPlay && availableResolutions && availableResolutions.length > 0 && status !== 4) {
      loggedEarlyPlay = true;
      await logEvent({
        videoId, pipeline: pipelineName,
        step: "bunny-earlyplay-ready",
        status: "success",
        detail: { availableResolutions, elapsedSec, guid },
      });
    }

    // Terminal: ready
    if (status === 4) {
      await logEvent({
        videoId, pipeline: pipelineName,
        step: "bunny-ready",
        status: "success",
        detail: { availableResolutions, width, height, elapsedSec, guid },
      });
      return { outcome: "ready", elapsedSec, guid };
    }
    // Terminal: error. If Bunny received 0 bytes within 30s we tag it as
    // "empty-source" so the caller can self-heal with a fresh RapidAPI URL.
    if (status === 5 || status === 6) {
      const storageSize = typeof match.storageSize === "number" ? match.storageSize : null;
      const empty = elapsedSec <= 30 && (storageSize === 0 || storageSize === null);
      await logEvent({
        videoId, pipeline: pipelineName,
        step: empty ? "bunny-empty-source" : "bunny-failed",
        status: "error",
        detail: { bunnyStatus: status, storageSize, elapsedSec, guid },
      });
      return { outcome: empty ? "empty-source" : "failed", elapsedSec, guid };
    }
  }
  // Timeout
  await logEvent({
    videoId, pipeline: pipelineName,
    step: "bunny-poll-timeout",
    status: "error",
    detail: { timeoutMinutes: 30, lastStatus },
  });
  return { outcome: "timeout", lastStatus };
}

// HEAD request with a short timeout. Used to verify a RapidAPI download_url
// is actually alive before handing it to Bunny's fetch-from-URL endpoint —
// stale URLs cause Bunny to accept the fetch job, receive 0 bytes, and
// status=5 within ~10 s (see Px3HfB2UkyU 2026-04-13).
function headUrl(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const req = https.request(url, { method: "HEAD" }, (res) => {
      settled = true;
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, elapsedMs: Date.now() - t0 });
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, status: 0, elapsedMs: Date.now() - t0, error: err.message });
    });
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ ok: false, status: 0, elapsedMs: Date.now() - t0, error: "timeout" });
    });
    req.end();
  });
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Bad JSON: ${body.slice(0, 200)}`)); } });
    }).on("error", reject);
  });
}

// Like httpsGet but returns {parsed, raw, status} so callers can inspect the
// raw body + status code when the response shape is unexpected.
function httpsGetFull(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        resolve({ parsed, raw: body, status: res.statusCode });
      });
    }).on("error", reject);
  });
}

// Retry init on transient RapidAPI failure. Returns the successful initRes,
// or throws after all attempts fail. Each failure logs to console + admin log.
async function rapidapiInitWithRetry({ videoId, pipelineName, requestUrl, headers, quality }) {
  const backoffsMs = [5_000, 15_000, 45_000];
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const { parsed, raw, status } = await httpsGetFull(requestUrl, headers);
      const elapsedMs = Date.now() - t0;
      if (parsed && parsed.success) {
        return parsed;
      }
      const rawSnippet = (raw || "").slice(0, 300);
      const reason = parsed?.message || parsed?.error || `status=${status}, raw="${rawSnippet}"`;
      console.log(`  [${videoId}] RapidAPI init attempt ${attempt}/3 at ${quality}p failed in ${elapsedMs}ms: ${reason}`);
      await logEvent({
        videoId, pipeline: pipelineName, step: "rapidapi-init-failed", status: "error",
        detail: { attempt, quality: `${quality}p`, elapsedMs, httpStatus: status, rawSnippet, parsed },
      });
      lastErr = new Error(`attempt ${attempt}/3: ${reason}`);
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      console.log(`  [${videoId}] RapidAPI init attempt ${attempt}/3 at ${quality}p threw in ${elapsedMs}ms: ${err.message}`);
      await logEvent({
        videoId, pipeline: pipelineName, step: "rapidapi-init-failed", status: "error",
        detail: { attempt, quality: `${quality}p`, elapsedMs, error: err.message },
      });
      lastErr = err;
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, backoffsMs[attempt - 1]));
    }
  }
  throw lastErr || new Error("rapidapi init failed after 3 attempts");
}

async function ingestToBunny(videoId, sourceUrl = null) {
  if (!BUNNY_STREAM_API_KEY) {
    console.log(`  [${videoId}] Bunny: skipped (no API key)`);
    return "skipped";
  }
  try {
    const url = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/fetch`;
    const body = JSON.stringify({
      url: sourceUrl || `https://storage.googleapis.com/${GCS_BUCKET}/${GCS_PREFIX}/${videoId}.mp4`,
      title: videoId,
    });
    const res = await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: "POST",
        headers: {
          AccessKey: BUNNY_STREAM_API_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    if (res.status >= 200 && res.status < 300) {
      console.log(`  [${videoId}] Bunny: queued for transcoding`);
      return "queued";
    } else {
      console.log(`  [${videoId}] Bunny: fetch API returned ${res.status}: ${JSON.stringify(res.body)}`);
      return "failed";
    }
  } catch (err) {
    console.log(`  [${videoId}] Bunny: ingest error: ${err.message}`);
    return "failed";
  }
}

const RUN_ID = `run-${Date.now()}`;
const startTime = Date.now();
let results = [];
let label = "";

// --- Real-time status broadcasting to GCS ---

let statusDirty = false;
let statusInterval = null;

function buildStatus() {
  const now = Date.now();
  const counts = { pending: 0, rapidapi: 0, downloading: 0, uploading: 0, complete: 0, skipped: 0, failed: 0 };
  const totalCost = results.reduce((s, r) => s + (r.apiCost || 0), 0);
  const totalBytes = results.reduce((s, r) => s + (r.fileSize || 0), 0);
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  return {
    runId: RUN_ID,
    label,
    batchSize: BATCH_SIZE,
    batchOffset: BATCH_OFFSET,
    maxConcurrent: MAX_CONCURRENT,
    infra: {
      cpu: process.env.CR_CPU || "unknown",
      memory: process.env.CR_MEMORY || "unknown",
      region: process.env.CR_REGION || "us-central1",
      taskIndex: TASK_INDEX,
      taskCount: TASK_COUNT,
    },
    startedAt: new Date(startTime).toISOString(),
    updatedAt: new Date().toISOString(),
    elapsedSeconds: Math.round((now - startTime) / 1000),
    counts,
    totalCost,
    totalBytesDL: totalBytes,
    totalMBDL: (totalBytes / 1024 / 1024).toFixed(1),
    videos: results.map(r => ({
      id: r.id,
      title: r.title,
      speaker: r.speaker,
      duration: r.duration,
      status: r.status,
      resolution: r.resolution || null,
      apiCost: r.apiCost || 0,
      apiProgress: r.rapidapiProgress || null,
      apiPollCount: r.apiPollCount || 0,
      apiElapsed: r.apiElapsed || null,
      apiRequestUrl: r.apiRequestUrl || null,
      apiRequestHeaders: r.apiRequestHeaders || null,
      apiInitResponse: r.apiInitResponse || null,
      apiLastPollResponse: r.apiLastPollResponse || null,
      apiPollSamples: r.apiPollSamples || [],
      downloadSpeedMBs: r.downloadSpeedMBs || null,
      downloadedMB: r.downloadedMB || null,
      fileSize: r.fileSize || null,
      fileSizeMB: r.fileSizeMB || null,
      uploadSpeedMBs: r.uploadSpeedMBs || null,
      uploadElapsed: r.uploadElapsed || null,
      elapsed: r.elapsed || null,
      error: r.error || null,
      gcsUrl: r.gcsUrl || null,
      bunnyStatus: r.bunnyStatus || null,
    })),
  };
}

async function flushStatus() {
  if (!statusDirty) return;
  statusDirty = false;
  try {
    const status = buildStatus();
    await bucket.file(STATUS_PATH).save(JSON.stringify(status), {
      contentType: "application/json",
      metadata: { cacheControl: "no-cache, no-store, max-age=0" },
    });
  } catch (e) {
    console.error("Status flush error:", e.message);
  }
}

function markDirty() { statusDirty = true; }

function startStatusLoop() {
  statusInterval = setInterval(flushStatus, 3000);
}

function stopStatusLoop() {
  if (statusInterval) clearInterval(statusInterval);
}

// --- Download with speed tracking ---

function downloadFile(url, outPath, video, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const id = video.id;
    const tag = `  [${id}]`;
    console.log(`${tag} curl URL: ${url.slice(0, 120)}...`);
    const child = spawn("curl", ["--http1.1", "-L", "--max-time", "300", "-sS", "-w", "\nHTTP %{http_code} | %{size_download} bytes | %{speed_download} B/s\n", "-o", outPath, url], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let lastSize = 0;

    child.stdout.on("data", (d) => {
      const text = d.toString().trim();
      if (text) {
        console.log(`${tag} curl: ${text}`);
        // Parse final curl write-out for speed
        const m = text.match(/(\d+) bytes \| ([\d.]+) B\/s/);
        if (m) {
          video.downloadSpeedMBs = (parseFloat(m[2]) / 1024 / 1024).toFixed(1);
        }
      }
    });
    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      const text = chunk.trim();
      if (text) console.log(`${tag} curl error: ${text}`);
    });

    const sizeTimer = setInterval(() => {
      try {
        const { size } = statSync(outPath);
        const speedMBs = ((size - lastSize) / 1024 / 1024 / 5).toFixed(1);
        lastSize = size;
        video.downloadedMB = (size / 1024 / 1024).toFixed(1);
        video.downloadSpeedMBs = speedMBs;
        markDirty();
        console.log(`${tag} progress: ${video.downloadedMB} MB (${speedMBs} MB/s)`);
      } catch {}
    }, 5_000);

    const timer = setTimeout(() => {
      child.kill();
      clearInterval(sizeTimer);
      reject(new Error(`Download timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(sizeTimer);
      if (code === 0) resolve();
      else reject(new Error(`curl exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function runPool(items, fn, limit) {
  const executing = new Set();
  for (const item of items) {
    const p = fn(item).then(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

// --- Process one video ---

async function processVideo(video) {
  const gcsPath = `${GCS_PREFIX}/${video.id}.mp4`;

  const [exists] = await bucket.file(gcsPath).exists();
  if (exists) {
    console.log(`  [${video.id}] SKIP: already in GCS`);
    video.status = "skipped";
    video.gcsUrl = `gs://${GCS_BUCKET}/${gcsPath}`;
    markDirty();
    return;
  }

  const start = Date.now();
  const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;

  // Resume-from-Vercel: if trigger-bunny pre-inited RapidAPI, skip init on the
  // matching quality iteration. Env vars consumed once so 720p fallback
  // re-inits normally if 1080p fails mid-poll.
  let resumeProgressUrl = process.env.PROGRESS_URL || null;
  const resumeQuality = process.env.QUALITY || null;

  for (const quality of ["1080", "720"]) {
    try {
      video.status = "rapidapi";
      video.resolution = `${quality}p`;
      video.apiPollCount = 0;
      video.apiPollSamples = [];
      markDirty();

      let initRes;
      if (resumeProgressUrl && resumeQuality === quality) {
        console.log(`  [${video.id}] RapidAPI: resuming ${quality}p from Vercel-provided PROGRESS_URL`);
        initRes = { progress_url: resumeProgressUrl, success: 1 };
        video.apiInitResponse = { resumedFromVercel: true };
        resumeProgressUrl = null;
        markDirty();
      } else {
        const params = new URLSearchParams({
          format: quality, add_info: "0", url: videoUrl,
          allow_extended_duration: "1", no_merge: "false",
        });
        console.log(`  [${video.id}] RapidAPI: requesting ${quality}p...`);
        await logEvent({ videoId: video.id, pipeline: MODE === "bunny-only" ? "transcribe" : "research", step: "rapidapi-init", status: "info", detail: { quality: `${quality}p` } });

        const requestUrl = `https://${RAPIDAPI_HOST}/ajax/download.php?${params}`;
        video.apiRequestUrl = requestUrl;
        video.apiRequestHeaders = {
          "Content-Type": "application/json",
          "x-rapidapi-host": RAPIDAPI_HOST,
          "x-rapidapi-key": RAPIDAPI_KEY.slice(0, 8) + "...",
        };

        const initHeaders = {
          "Content-Type": "application/json",
          "x-rapidapi-host": RAPIDAPI_HOST,
          "x-rapidapi-key": RAPIDAPI_KEY,
        };
        initRes = await rapidapiInitWithRetry({
          videoId: video.id,
          pipelineName: MODE === "bunny-only" ? "transcribe" : "research",
          requestUrl,
          headers: initHeaders,
          quality,
        });
        video.apiInitResponse = initRes;

        video.apiCost = (video.apiCost || 0) + (initRes.extended_duration?.final_price || 0);
        console.log(`  [${video.id}] RapidAPI cost: $${initRes.extended_duration?.final_price || "?"} (${initRes.extended_duration?.multiplier || "?"}x)`);
        markDirty();
      }

      const progressUrl = initRes.progress_url;
      let pollCount = 0;
      while (true) {
        await new Promise(r => setTimeout(r, 5000));
        pollCount++;
        let progress;
        try { progress = await httpsGet(progressUrl); } catch { continue; }

        video.rapidapiProgress = `${progress.progress}% ${progress.text}`;
        video.apiPollCount = pollCount;
        video.apiElapsed = `${pollCount * 5}s`;
        video.apiLastPollResponse = progress;
        // Sample every 6th poll (every 30s)
        if (pollCount % 6 === 0) {
          video.apiPollSamples.push({ poll: pollCount, elapsed: `${pollCount * 5}s`, ...progress });
          console.log(`  [${video.id}] RapidAPI: ${progress.progress}% ${progress.text} (${pollCount * 5}s)`);
          await logEvent({
            videoId: video.id,
            pipeline: MODE === "bunny-only" ? "transcribe" : "research",
            step: "rapidapi-progress",
            status: "info",
            detail: { quality: `${quality}p`, progress: progress.progress, text: progress.text, elapsedSec: pollCount * 5 },
          });
        }
        markDirty();

        if (progress.text && (progress.text.toLowerCase().includes("private") || progress.text.toLowerCase().includes("unavailable"))) {
          throw new Error(`Video is ${progress.text}`);
        }

        // Detect terminal failure states from RapidAPI (progress=1000 with error text)
        if (progress.progress >= 1000 && progress.text && !progress.download_url) {
          const t = progress.text.toLowerCase();
          if (t.includes("too long") || t.includes("livestream") || t.includes("no files") || t.includes("aborting") || t.includes("error") || t.includes("took too long")) {
            throw new Error(`RapidAPI rejected: ${progress.text}`);
          }
        }

        if (progress.success === 1 && progress.download_url) {
          console.log(`  [${video.id}] RapidAPI: ready (${pollCount * 5}s)`);
          await logEvent({ videoId: video.id, pipeline: MODE === "bunny-only" ? "transcribe" : "research", step: "rapidapi-ready", status: "success", detail: { quality: `${quality}p`, elapsedSec: pollCount * 5 } });

          if (MODE === "bunny-only") {
            // Bunny-only mode: skip disk download + GCS upload. Hand the
            // RapidAPI download_url straight to Bunny's fetch-from-URL API.
            console.log(`  [${video.id}] MODE=bunny-only → Bunny fetching directly from RapidAPI (${quality}p). No GCS.`);

            // Freshness check: HEAD the download URL before handing to Bunny.
            // Stale URLs cause Bunny to accept the fetch but receive 0 bytes.
            const head = await headUrl(progress.download_url);
            await logEvent({
              videoId: video.id, pipeline: "transcribe", step: "rapidapi-url-check",
              status: head.ok ? "success" : "error",
              detail: { quality: `${quality}p`, httpStatus: head.status, elapsedMs: head.elapsedMs, error: head.error },
            });
            if (!head.ok) {
              console.log(`  [${video.id}] rapidapi-url-check failed (${head.status || head.error}); falling through to next format`);
              continue;
            }

            video.bunnyStatus = await ingestToBunny(video.id, progress.download_url);
            video.status = video.bunnyStatus === "queued" ? "complete" : "failed";
            video.resolution = `${quality}p`;
            video.elapsed = `${((Date.now() - start) / 1000).toFixed(1)}s`;
            markDirty();
            console.log(`  [${video.id}] DONE (bunny-only): ${video.elapsed}, ${quality}p, bunny=${video.bunnyStatus}`);
            await logEvent({ videoId: video.id, pipeline: "transcribe", step: "bunny-fetch-queued", status: video.bunnyStatus === "queued" ? "success" : "error", detail: { quality: `${quality}p`, bunnyStatus: video.bunnyStatus, elapsedSec: Math.round((Date.now() - start) / 1000) } });

            // Stay alive and follow Bunny's encode progress. If Bunny reports
            // empty-source (status=5, storageSize=0 inside 30s) the URL died
            // between our HEAD check and Bunny's fetch — fall through to the
            // next format for a fresh RapidAPI URL.
            if (video.bunnyStatus === "queued") {
              const result = await pollBunnyUntilReady(video.id, "transcribe");
              if (result?.outcome === "empty-source") {
                console.log(`  [${video.id}] bunny empty-source; falling through to next format for a fresh URL`);
                continue;
              }
            }
            console.log("");
            return;
          }

          video.status = "downloading";
          video.downloadedMB = "0";
          video.downloadSpeedMBs = "0";
          markDirty();
          const tmpFile = join(tmpdir(), `gcs-dl-${video.id}.mp4`);
          console.log(`  [${video.id}] Downloading to disk...`);
          try { unlinkSync(tmpFile); } catch {}
          await downloadFile(progress.download_url, tmpFile, video);

          const fileSize = statSync(tmpFile).size;
          if (fileSize < 1_000_000) throw new Error(`Download too small (${fileSize} bytes), likely an error page`);
          video.fileSize = fileSize;
          video.fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);
          video.downloadedMB = video.fileSizeMB;
          console.log(`  [${video.id}] Downloaded: ${video.fileSizeMB} MB (${quality}p)`);

          video.status = "uploading";
          const uploadStart = Date.now();
          markDirty();
          console.log(`  [${video.id}] Uploading to GCS...`);
          await bucket.upload(tmpFile, {
            destination: gcsPath,
            timeout: 600000,
            metadata: { contentType: "video/mp4", cacheControl: "public, max-age=31536000" },
          });
          const uploadMs = Date.now() - uploadStart;
          video.uploadElapsed = `${(uploadMs / 1000).toFixed(1)}s`;
          video.uploadSpeedMBs = (fileSize / 1024 / 1024 / (uploadMs / 1000)).toFixed(1);
          unlinkSync(tmpFile);

          video.status = "complete";
          video.gcsUrl = `gs://${GCS_BUCKET}/${gcsPath}`;
          video.elapsed = `${((Date.now() - start) / 1000).toFixed(1)}s`;
          markDirty();
          console.log(`  [${video.id}] DONE: ${video.elapsed}, ${quality}p, $${video.apiCost} | DL ${video.downloadSpeedMBs} MB/s | UL ${video.uploadSpeedMBs} MB/s`);

          // Ingest to Bunny Stream (non-blocking)
          video.bunnyStatus = await ingestToBunny(video.id);
          markDirty();
          await logEvent({ videoId: video.id, pipeline: "research", step: "bunny-fetch-queued", status: video.bunnyStatus === "queued" ? "success" : "error", detail: { quality: `${quality}p`, bunnyStatus: video.bunnyStatus } });
          console.log("");
          return;
        }
        if (progress.text === "Error" || progress.progress < 0) {
          throw new Error(`RapidAPI failed: ${progress.text}`);
        }
      }
    } catch (err) {
      if (quality === "1080") {
        console.log(`  [${video.id}] 1080p failed: ${err.message}, retrying at 720p...`);
        continue;
      }
      throw err;
    }
  }
}

// --- Main ---

async function main() {
  const SINGLE_VIDEO_ID = (process.env.VIDEO_ID || "").trim();

  console.log(`Cloud Run Job: batch=${BATCH_SIZE}, offset=${BATCH_OFFSET}, concurrency=${MAX_CONCURRENT}, task=${TASK_INDEX}/${TASK_COUNT}`);
  if (SINGLE_VIDEO_ID) console.log(`Single-video mode: ${SINGLE_VIDEO_ID}`);
  console.log(`Run ID: ${RUN_ID}\n`);

  const VIDEO_LIST = (process.env.VIDEO_LIST || "").trim();

  if (SINGLE_VIDEO_ID) {
    // Single-video mode — skip BigQuery query, process one video directly
    results = [{ id: SINGLE_VIDEO_ID, title: "single", duration: null, speaker: null, status: "pending" }];
    label = `Single video: ${SINGLE_VIDEO_ID}`;
  } else if (VIDEO_LIST) {
    // List mode — download specific video IDs, split across tasks
    const allIds = VIDEO_LIST.split(',').map(id => id.trim()).filter(Boolean);
    const allResults = allIds.map(id => ({ id, title: "listed", duration: null, speaker: null, status: "pending" }));
    const perTask = Math.ceil(allResults.length / TASK_COUNT);
    const myStart = TASK_INDEX * perTask;
    results = allResults.slice(myStart, myStart + perTask);
    if (results.length === 0) { console.log(`Task ${TASK_INDEX}: no videos in my slice, exiting.`); process.exit(0); }
    label = `Task ${TASK_INDEX}: ${results.length} of ${allIds.length} videos from VIDEO_LIST`;
    console.log(`VIDEO_LIST mode: ${allIds.length} total IDs, task ${TASK_INDEX} gets ${results.length}`);
  } else {
    // Batch mode — query BigQuery and slice by offset/task
    console.log(`Querying BigQuery for all videos...`);
    const [rows] = await bigquery.query({
      query: `SELECT video_id, video_title, video_length, speaker_source FROM \`youtubetranscripts-429803.reptranscripts.youtube_videos\` ORDER BY LOWER(speaker_source), published_date DESC`,
    });

    const seen = new Set();
    const allDeduped = [];
    for (const r of rows) {
      if (!seen.has(r.video_id)) {
        seen.add(r.video_id);
        allDeduped.push(r);
      }
    }

    console.log(`Total unique videos: ${allDeduped.length}`);

    // Get full batch, then split by task index
    const fullBatch = allDeduped.slice(BATCH_OFFSET, BATCH_OFFSET + BATCH_SIZE);
    if (fullBatch.length === 0) { console.error(`No videos found (offset ${BATCH_OFFSET} exceeds ${allDeduped.length} total)`); process.exit(1); }

    // Each task gets its slice of the batch
    const perTask = Math.ceil(fullBatch.length / TASK_COUNT);
    const myStart = TASK_INDEX * perTask;
    const mySlice = fullBatch.slice(myStart, myStart + perTask);

    if (mySlice.length === 0) { console.log(`Task ${TASK_INDEX}: no videos in my slice, exiting.`); process.exit(0); }

    console.log(`Task ${TASK_INDEX}: processing videos ${myStart}-${myStart + mySlice.length - 1} of ${fullBatch.length} total`);

    results = mySlice.map(r => ({
      id: r.video_id,
      title: r.video_title,
      duration: r.video_length,
      speaker: r.speaker_source,
      status: "pending",
    }));

    const speakerCounts = {};
    for (const r of results) speakerCounts[r.speaker] = (speakerCounts[r.speaker] || 0) + 1;
    const speakerNames = Object.keys(speakerCounts).sort((a, b) => a.localeCompare(b));
    label = `Task ${TASK_INDEX}: ${results.length} videos (${speakerNames[0]} → ${speakerNames[speakerNames.length - 1]})`;
  }

  if (typeof speakerNames !== "undefined" && speakerNames.length > 0) {
    console.log(`${results.length} videos across ${speakerNames.length} speakers:`);
    for (const s of speakerNames) console.log(`  ${speakerCounts[s].toString().padStart(3)} ${s}`);
  } else {
    console.log(`${results.length} videos to process`);
  }
  console.log(`\nDownloading to GCS (${GCS_BUCKET}/${GCS_PREFIX}/)\n`);

  // Start status broadcasting
  markDirty();
  startStatusLoop();

  await runPool(results, (video) =>
    processVideo(video).catch(err => {
      video.status = "failed";
      video.error = err.message;
      markDirty();
      console.error(`  [${video.id}] FAILED: ${err.message}\n`);
    }),
    MAX_CONCURRENT
  );

  stopStatusLoop();

  // Final save
  const totalCost = results.reduce((s, r) => s + (r.apiCost || 0), 0);
  await saveResultsToGCS(totalCost);
  statusDirty = true;
  await flushStatus();

  console.log("\n=== SUMMARY ===");
  console.log(label);
  console.log(`Total: ${results.length} videos`);
  console.log(`Complete: ${results.filter(r => r.status === "complete").length}`);
  console.log(`Skipped: ${results.filter(r => r.status === "skipped").length}`);
  console.log(`Failed: ${results.filter(r => r.status === "failed").length}`);
  console.log(`Total RapidAPI cost: $${totalCost.toFixed(5)}`);
  console.log(`Results saved to: gs://${GCS_BUCKET}/${RESULTS_PREFIX}/${RUN_ID}.json`);
}

async function saveResultsToGCS(totalCost) {
  const runData = { runId: RUN_ID, speaker: label, results, totalCost, timestamp: new Date().toISOString() };
  await bucket.file(`${RESULTS_PREFIX}/${RUN_ID}.json`).save(JSON.stringify(runData, null, 2), { contentType: "application/json" });
}

main()
  .catch(console.error)
  .finally(async () => {
    if (_redis) { try { await _redis.quit(); } catch {} }
  });
