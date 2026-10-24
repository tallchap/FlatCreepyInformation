const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process"); // v3
const { readFile, unlink } = require("fs/promises");
const { tmpdir } = require("os");
const { join } = require("path");
const crypto = require("crypto");
const fs = require("fs");

// Crash logging — write to /tmp/crash.log before dying so next startup can show what happened
process.on("uncaughtException", (err) => {
  try { fs.appendFileSync("/tmp/crash.log", `[${new Date().toISOString()}] UNCAUGHT: ${err.stack || err}\n`); } catch {}
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  try { fs.appendFileSync("/tmp/crash.log", `[${new Date().toISOString()}] UNHANDLED_REJECTION: ${reason}\n`); } catch {}
  console.error("UNHANDLED REJECTION:", reason);
});

// BigQuery clip stats
const BQ_PROJECT = "youtubetranscripts-429803";
const BQ_DATASET = "reptranscripts";
const BQ_TABLE = "clip_exports";
let bigquery = null;
try {
  const { BigQuery } = require("@google-cloud/bigquery");
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credJson) {
    let credentials;
    try { credentials = JSON.parse(credJson); } catch {
      // Fix private_key newlines that break JSON.parse
      const fixed = credJson.replace(
        /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
        (_m, key) => `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
      );
      credentials = JSON.parse(fixed);
    }
    bigquery = new BigQuery({ projectId: BQ_PROJECT, credentials });
    console.log("BigQuery client initialized");
  }
} catch (e) {
  console.log("BigQuery not available:", e.message);
}

async function logClipToBigQuery(row) {
  if (!bigquery) return;
  try {
    await bigquery.dataset(BQ_DATASET).table(BQ_TABLE).insert([row]);
  } catch (e) {
    console.error("BigQuery insert error:", e.message);
  }
}

// ─── Redis event writer (for admin /log Clips tab in-flight view) ────
// Mirrors the pipeline:* key shape used by src/lib/pipeline-log.ts so the
// admin log can read clip events through the same reader pattern as the
// transcribe pipeline. Silently no-ops when REDIS_URL isn't set.
let _redisClient = null;
function redisClient() {
  if (_redisClient !== null) return _redisClient;
  const url = process.env.REDIS_URL;
  if (!url) { _redisClient = false; return null; }
  try {
    const Redis = require("ioredis");
    _redisClient = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    _redisClient.on("error", (e) => console.error("[clip-redis]", e.message));
    console.log("Redis client initialized for clip events");
    return _redisClient;
  } catch (e) {
    console.error("Redis init failed:", e.message);
    _redisClient = false;
    return null;
  }
}

async function logClipEvent({ jobId, videoId, pipeline, step, status, detail }) {
  const r = redisClient();
  if (!r) return;
  try {
    const ts = Date.now();
    const payload = JSON.stringify({ ts, jobId, videoId, pipeline, step, status, detail });
    const listKey = `pipeline:clip:${jobId}`;
    const latestKey = `pipeline:clip-latest:${jobId}`;
    const activeKey = "pipeline:clip-active";
    const dayTtl = 60 * 60 * 24;
    await Promise.all([
      r.lpush(listKey, payload),
      r.ltrim(listKey, 0, 199),
      r.expire(listKey, dayTtl),
      r.hset(latestKey, { step, status, pipeline, videoId: videoId || "", ts: String(ts) }),
      r.expire(latestKey, dayTtl),
      r.sadd(activeKey, jobId),
      r.expire(activeKey, dayTtl),
    ]);
    const isTerminal =
      step === "clip-complete" ||
      step === "clip-failed" ||
      step === "clip-rejected";
    if (isTerminal) {
      await r.srem(activeKey, jobId);
    }
  } catch (e) {
    console.error("[logClipEvent]", e.message);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// Log every incoming HTTP request
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logDebug("http.request", { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

const WARP_PROXY = "http://127.0.0.1:8080";
let warpAvailable = false;
const startupState = { warp: {}, bgutil: {}, ytdlp: {}, wireproxyConf: null };

// RapidAPI YouTube download
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_HOST = "youtube-info-download-api.p.rapidapi.com";
const downloadUrlCache = new Map(); // videoId → { url, expiresAt }

async function rapidApiDownload(videoUrl, quality, job) {
  const https = require("https");
  const format = quality === "1080p" ? "1080" : "720";
  const params = new URLSearchParams({
    format,
    add_info: "0",
    url: videoUrl,
    allow_extended_duration: "1",
    no_merge: "false",
  });

  // Step 1: Request download
  const initRes = await new Promise((resolve, reject) => {
    https.get(`https://${RAPIDAPI_HOST}/ajax/download.php?${params}`, {
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": RAPIDAPI_HOST,
        "x-rapidapi-key": RAPIDAPI_KEY,
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });

  if (!initRes.success) throw new Error(`RapidAPI init failed: ${initRes.message}`);
  logDebug("rapidapi.requested", { id: initRes.id, progress_url: initRes.progress_url });

  // Step 2: Poll progress — no fixed timeout, stall detection instead
  const progressUrl = initRes.progress_url;
  const BASE_STALL = 240_000;      // 4 min base stall timeout
  const STALL_EXTENSION = 60_000;  // +1 min per progress change (reward active jobs)
  const MAX_STALL = 720_000;       // 12 min cap
  let pollCount = 0;
  let lastProgress = null;
  let lastProgressValue = -1;
  let lastProgressText = "";
  let lastProgressChangeTime = Date.now();
  let progressChanges = 0;
  let consecutiveErrors = 0;

  while (true) {
    await new Promise(r => setTimeout(r, 5000));
    pollCount++;

    // Poll with transient error resilience
    let progress;
    try {
      progress = await new Promise((resolve, reject) => {
        https.get(progressUrl, (res) => {
          let body = "";
          res.on("data", (c) => body += c);
          res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Bad JSON: ${body.slice(0, 200)}`)); } });
        }).on("error", reject);
      });
      consecutiveErrors = 0;
    } catch (pollErr) {
      consecutiveErrors++;
      if (consecutiveErrors >= 10) {
        throw new Error(`RapidAPI polling failed ${consecutiveErrors} times in a row. Last error: ${pollErr.message}`);
      }
      if (consecutiveErrors === 1 || consecutiveErrors % 5 === 0) {
        logDebug("rapidapi.poll-error", { error: pollErr.message, consecutiveErrors, pollCount });
      }
      continue;
    }
    lastProgress = progress;

    // Track progress changes for stall detection (reset on number OR phase change)
    if (progress.progress !== lastProgressValue || progress.text !== lastProgressText) {
      lastProgressValue = progress.progress;
      lastProgressText = progress.text;
      lastProgressChangeTime = Date.now();
      progressChanges++;
    }

    // Update job stage for frontend visibility
    if (job) {
      job.stage = "rapidapi-processing";
      job.stageDetail = `RapidAPI: ${progress.progress}% — ${progress.text || "processing"}`;
    }

    // Log every 6 polls (~30s)
    if (pollCount % 6 === 0) {
      logDebug("rapidapi.polling", { progress: progress.progress, text: progress.text, pollCount, elapsed: `${pollCount * 5}s` });
    }

    if (progress.success === 1 && progress.download_url) {
      logDebug("rapidapi.ready", { download_url: progress.download_url, pollCount, elapsed: `${pollCount * 5}s` });
      return progress.download_url;
    }
    if (progress.text === "Error" || progress.progress < 0) {
      throw new Error(`RapidAPI processing failed: ${progress.text}`);
    }
    // Stall detection: dynamic timeout — jobs that made more progress get more patience
    const dynamicTimeout = Math.min(BASE_STALL + progressChanges * STALL_EXTENSION, MAX_STALL);
    if (Date.now() - lastProgressChangeTime > dynamicTimeout) {
      logDebug("rapidapi.stalled", { lastProgress, pollCount, elapsed: `${pollCount * 5}s`, stalledAt: lastProgressValue, progressChanges, dynamicTimeoutMin: (dynamicTimeout / 60_000).toFixed(1) });
      throw new Error(`RapidAPI stalled at ${lastProgressValue}% for ${(dynamicTimeout / 60_000).toFixed(0)}min (${progressChanges} changes). Last: ${JSON.stringify(lastProgress)}`);
    }
  }
}

// Probe a TCP port, returns true/false
function probePort(port, host = "127.0.0.1", timeoutMs = 2000) {
  return new Promise((resolve) => {
    const net = require("net");
    const sock = net.connect(port, host, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve(false); });
  });
}

// Startup diagnostics — runs after services have had time to start
setTimeout(async () => {
  const fs = require("fs");
  const http = require("http");

  // Check WARP ports
  const socks5Up = await probePort(1080);
  const httpUp = await probePort(8080);
  startupState.warp = { socks5_1080: socks5Up, http_8080: httpUp };

  if (httpUp) {
    warpAvailable = true;
    console.log("WARP HTTP proxy detected on :8080");
  } else if (socks5Up) {
    console.log("WARP SOCKS5 on :1080 but HTTP :8080 not available");
  } else {
    console.log("WARP proxy not available — yt-dlp will use direct connection");
  }

  // Check bgutil PO token server
  try {
    const pingData = await new Promise((resolve, reject) => {
      http.get("http://127.0.0.1:4416/ping", (res) => {
        let body = "";
        res.on("data", (c) => body += c);
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
      }).on("error", reject).setTimeout(3000, () => reject(new Error("timeout")));
    });
    startupState.bgutil = { status: "up", ...pingData };
  } catch (e) {
    startupState.bgutil = { status: "down", error: e.message };
  }

  // Check yt-dlp version
  try {
    const result = await execCapture("yt-dlp", ["--version"], { timeout: 5000 });
    startupState.ytdlp = { version: result.stdout.trim() };
  } catch (e) {
    startupState.ytdlp = { error: e.message };
  }

  // Read wireproxy config
  try {
    startupState.wireproxyConf = fs.readFileSync("/etc/wireproxy.conf", "utf8");
  } catch {
    startupState.wireproxyConf = "(not found)";
  }

  logDebug("startup.diagnostics", startupState);
}, 2000);

const DEBUG_LOG_LIMIT = 200;
const debugEvents = [];

function logDebug(stage, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    stage,
    details: JSON.parse(JSON.stringify(details, (_k, v) => {
      if (typeof v !== "string") return v;
      // Redact proxy credentials
      return v.replace(/([A-Za-z0-9_\-]{8,}):(\/[\/])?([A-Za-z0-9\/+_=\-]{8,})@/g, "[REDACTED]:$2[REDACTED]@");
    })),
  };
  debugEvents.push(entry);
  if (debugEvents.length > DEBUG_LOG_LIMIT) debugEvents.shift();
  console.log(`[debug] ${stage}`, entry.details);
  return entry;
}

// ─── bgutil PO token helper ─────────────────────────────────────────

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
  } catch {}
  return null;
}

function fetchPOToken(videoId) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const postData = JSON.stringify(videoId ? { content_binding: videoId } : {});
    const req = http.request("http://127.0.0.1:4416/get_pot", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
      timeout: 30000,
    }, (r) => {
      let body = "";
      r.on("data", (d) => body += d);
      r.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error));
          resolve({ poToken: data.poToken, contentBinding: data.contentBinding });
        } catch (e) {
          reject(new Error(`bgutil parse error: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("bgutil timeout")); });
    req.write(postData);
    req.end();
  });
}

// ─── yt-dlp helpers ─────────────────────────────────────────────────

function execCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, opts, (error) => {
      if (error) {
        error.stderr = stderrChunks.join("");
        error.stdout = stdoutChunks.join("");
        reject(error);
      } else {
        resolve({ stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") });
      }
    });
    const stderrChunks = [];
    const stdoutChunks = [];
    if (proc.stderr) proc.stderr.on("data", (d) => stderrChunks.push(d.toString()));
    if (proc.stdout) proc.stdout.on("data", (d) => stdoutChunks.push(d.toString()));
  });
}

async function getVideoMetadata(filePath) {
  try {
    const result = await execCapture("ffprobe", [
      "-v", "warning", "-print_format", "json",
      "-show_format", "-show_streams", filePath,
    ], { timeout: 10_000 });
    const data = JSON.parse(result.stdout);
    const videoStream = data.streams?.find(s => s.codec_type === "video");
    return {
      duration_sec: parseFloat(data.format?.duration) || null,
      width: videoStream?.width || null,
      height: videoStream?.height || null,
      warnings: result.stderr || "",
    };
  } catch { return { duration_sec: null, width: null, height: null, warnings: "" }; }
}

function ytdlpBaseArgs({ useProxy = false } = {}) {
  const args = [];
  if (useProxy && warpAvailable) {
    args.push("--proxy", WARP_PROXY);
  }
  args.push(
    "--extractor-args", "youtube:player_client=mweb;fetch_pot=always",
    "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
    "--remote-components", "ejs:github",
  );
  args.push(
    "--sleep-interval", "5",
    "--max-sleep-interval", "10",
    "--retries", "10",
    "--retry-sleep", "5",
  );
  return args;
}

async function execYtdlp(url, args, opts = {}) {
  const { useProxy = false, ...execOpts } = opts;
  const fullArgs = [...ytdlpBaseArgs({ useProxy }), ...args];
  const start = Date.now();
  logDebug("ytdlp.exec", { proxy: useProxy && warpAvailable, args: fullArgs.join(" ") });

  try {
    const result = await execCapture("yt-dlp", fullArgs, execOpts);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logDebug("ytdlp.success", { elapsed: `${elapsed}s`, stderr: result.stderr.slice(0, 2000) });
    return result;
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logDebug("ytdlp.error", { elapsed: `${elapsed}s`, stderr: (e.stderr || "").slice(0, 1000), message: e.message });
    throw e;
  }
}

// ─── Endpoints ───────────────────────────────────────────────────────

app.post("/download", async (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const quality = req.body.quality === "1080p" ? 1080 : 720;
  const outfile = join(tmpdir(), `video-${crypto.randomUUID()}.mp4`);

  try {
    logDebug("download.start", { url, quality });

    const dlArgs = [
      url,
      "-f", `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`,
      "--merge-output-format", "mp4",
      "-o", outfile,
    ];

    // Try direct first, WARP fallback
    try {
      await execYtdlp(url, dlArgs, { timeout: 300_000, useProxy: false });
    } catch (directErr) {
      logDebug("download.direct-failed", { error: (directErr.stderr || directErr.message || "").slice(0, 2000) });
      if (warpAvailable) {
        await execYtdlp(url, dlArgs, { timeout: 300_000, useProxy: true });
      } else {
        throw directErr;
      }
    }

    const data = await readFile(outfile);
    await unlink(outfile).catch(() => {});
    logDebug("download.complete", { bytes: data.byteLength, mb: (data.byteLength / 1024 / 1024).toFixed(1) });

    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="video.mp4"',
      "Content-Length": data.byteLength.toString(),
    });
    res.send(data);
  } catch (error) {
    await unlink(outfile).catch(() => {});
    const detail = error.stderr || error.message || "Unknown error";
    logDebug("download.error", { url, error: detail.slice(0, 1000) });
    console.error("Download error:", detail.slice(0, 2000));
    res.status(500).json({ error: `Download failed: ${detail.slice(0, 2000)}` });
  }
});

// ─── Segments (multi-range clips) ───────────────────────────────────
// A clip is a list of { in, out } ranges (seconds), joined in the order given.
// `startSec`/`endSec` stay accepted as a one-segment shorthand.
const MAX_CLIP_SEC = 11 * 60;
const MAX_SEGMENTS = 20;

function parseSegments(body) {
  let segments;
  let shorthand = false;
  if (Array.isArray(body.segments)) {
    segments = body.segments.map((s) => ({ in: Number(s && s.in), out: Number(s && s.out) }));
    if (segments.length < 1 || segments.length > MAX_SEGMENTS) {
      return { error: `segments must hold 1–${MAX_SEGMENTS} ranges (got ${segments.length})` };
    }
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (!Number.isFinite(s.in) || !Number.isFinite(s.out) || s.in < 0) return { error: `segment ${i + 1}: in/out must be numbers ≥ 0` };
      if (s.out - s.in < 1) return { error: `segment ${i + 1} is shorter than 1 s` };
    }
  } else if (body.startSec != null && body.endSec != null) {
    const s = { in: Number(body.startSec), out: Number(body.endSec) };
    if (!Number.isFinite(s.in) || !Number.isFinite(s.out) || s.out <= s.in) return { error: "endSec must be after startSec" };
    segments = [s];
    shorthand = true;
  } else {
    return { error: "Missing segments (or startSec/endSec)" };
  }
  const total = segments.reduce((a, s) => a + (s.out - s.in), 0);
  if (total > MAX_CLIP_SEC) return { error: `Clip exceeds ${MAX_CLIP_SEC / 60} minute limit (total ${total.toFixed(1)}s)`, total };
  const lengthSeconds = Number(body.lengthSeconds);
  if (Number.isFinite(lengthSeconds) && lengthSeconds > 0) {
    const bad = segments.findIndex((s) => s.out > lengthSeconds + 0.5);
    if (bad >= 0) return { error: `segment ${bad + 1} ends after the video (${lengthSeconds}s)` };
  }
  return { segments, total, shorthand };
}

const ENCODE_V = [
  "-c:v", "libx264", "-b:v", "2500k", "-maxrate", "2700k", "-bufsize", "5000k", "-preset", "fast", "-tune", "zerolatency",
  "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-bf", "0", "-refs", "1",
];

// Run ffmpeg, parse time= for progress, kill it if no progress for 5 min.
function runFfmpeg(args, { job, duration, label, onPct }) {
  return new Promise((resolve, reject) => {
    const lastLines = [];
    let lastEncodedSecs = 0;
    let previousCheckSecs = -1;
    const proc = execFile("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 }, (error) => {
      clearInterval(stallCheck);
      if (error) { error.stderr = lastLines.join("\n"); reject(error); }
      else resolve();
    });
    const stallCheck = setInterval(() => {
      if (lastEncodedSecs === previousCheckSecs) {
        logDebug("ffmpeg.stalled", { label, lastEncodedSecs });
        proc.kill();
      }
      previousCheckSecs = lastEncodedSecs;
    }, 300_000);
    if (proc.stderr) proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      text.split("\n").filter((l) => l.trim()).forEach((l) => { lastLines.push(l); if (lastLines.length > 10) lastLines.shift(); });
      const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (match && duration > 0) {
        const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
        lastEncodedSecs = secs;
        const pct = Math.min(99, Math.round((secs / duration) * 100));
        if (onPct) onPct(pct, `${match[1]}:${match[2]}:${match[3]}`);
      }
    });
  });
}

// Frame rate of the first video stream (e.g. 59.94), or null.
async function probeFps(input) {
  try {
    const r = await execCapture("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json", input], { timeout: 30_000 });
    const st = (JSON.parse(r.stdout).streams || [])[0] || {};
    for (const v of [st.avg_frame_rate, st.r_frame_rate]) {
      const [a, b] = String(v || "").split("/").map(Number);
      const fps = b ? a / b : a;
      if (Number.isFinite(fps) && fps > 1 && fps < 241) return fps;
    }
  } catch {}
  return null;
}

// Cut one segment out of a file/URL (frame-accurate re-encode). With the
// frame rate known, video is cut to round(len × fps) frames and audio to the
// same length, so every join lands within half a frame of where it should.
function cutSegmentArgs(input, seg, outFile, overlayFilter, fps) {
  const len = seg.out - seg.in;
  const frames = fps ? Math.max(1, Math.round(len * fps)) : null;
  const exact = frames ? frames / fps : len;
  return [
    "-err_detect", "ignore_err", "-fflags", "+genpts",
    "-ss", String(seg.in), "-to", String(seg.out + 0.1), "-i", input,
    "-map", "0:v:0", "-map", "0:a:0", "-dn", "-sn", "-map_chapters", "-1",
    ...(overlayFilter ? ["-vf", overlayFilter] : []),
    ...(frames ? ["-frames:v", String(frames)] : []),
    ...ENCODE_V,
    "-af", `atrim=duration=${exact.toFixed(6)},afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, exact - 0.03).toFixed(6)}:d=0.03`,
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", "-y", outFile,
  ];
}

// The single-range encode the editor has always used (kept byte-for-byte so
// one-segment exports behave exactly as before).
function legacySingleArgs(input, seg, outFile, overlayFilter) {
  const duration = seg.out - seg.in;
  return [
    "-err_detect", "ignore_err", "-fflags", "+genpts",
    "-ss", String(seg.in), "-to", String(seg.in + duration + 0.05), "-i", input,
    "-map", "0:v:0", "-map", "0:a:0", "-dn", "-sn", "-map_chapters", "-1",
    ...(overlayFilter ? ["-vf", overlayFilter] : []),
    ...ENCODE_V,
    "-af", `afade=t=out:st=${duration}:d=0.05`,
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", "-y", outFile,
  ];
}

// Cut every segment from `input` and join them into `clipFile`. Segment files
// are deleted as soon as the join finishes (or fails).
// `parts` = [{ input, seg }]: the range `seg` is cut out of file/URL `input`.
async function cutAndJoin({ jobId, job, parts, clipFile, overlay, videoWidth, pipeline, videoId }) {
  const fontPath = overlay?.fontFamily ? await downloadGoogleFont(overlay.fontFamily) : null;
  const overlayFilter = buildOverlayFilter(overlay, fontPath, videoWidth);
  const n = parts.length;
  const total = parts.reduce((a, p) => a + (p.seg.out - p.seg.in), 0);
  let doneSec = 0;

  if (n === 1) {
    const { input, seg } = parts[0];
    const duration = seg.out - seg.in;
    job.stage = "trimming-clip";
    job.stageDetail = "Trimming: 0%";
    logClipEvent({ jobId, videoId, pipeline, step: "ffmpeg-trim-start", status: "info", detail: { startSec: seg.in, duration, overlay: !!overlayFilter } });
    await runFfmpeg(legacySingleArgs(input, seg, clipFile, overlayFilter), {
      job, duration, label: `${jobId}-trim`,
      onPct: (pct) => { job.stageDetail = `Trimming: ${pct}%`; job.progress = Math.max(job.progress || 0, 50 + Math.round(pct * 0.45)); },
    });
    return;
  }

  const segFiles = parts.map((_, i) => join(tmpdir(), `seg-${jobId}-${i + 1}.mp4`));
  const listFile = join(tmpdir(), `seg-${jobId}-list.txt`);
  const fpsByInput = new Map();
  for (const p of parts) if (!fpsByInput.has(p.input)) fpsByInput.set(p.input, await probeFps(p.input));
  job.fps = fpsByInput.get(parts[0].input) || null;
  try {
    for (let i = 0; i < n; i++) {
      const { input, seg } = parts[i];
      const len = seg.out - seg.in;
      job.stage = `cutting ${i + 1}/${n}`;
      job.stageDetail = `Cutting ${i + 1}/${n}: 0%`;
      logClipEvent({ jobId, videoId, pipeline, step: "segment-cut-start", status: "info", detail: { index: i + 1, of: n, in: seg.in, out: seg.out } });
      await runFfmpeg(cutSegmentArgs(input, seg, segFiles[i], overlayFilter, fpsByInput.get(input)), {
        job, duration: len, label: `${jobId}-seg${i + 1}`,
        onPct: (pct) => {
          job.stageDetail = `Cutting ${i + 1}/${n}: ${pct}%`;
          job.progress = Math.max(job.progress || 0, 50 + Math.round(((doneSec + (len * pct) / 100) / total) * 40));
        },
      });
      doneSec += len;
    }
    job.stage = "joining";
    job.stageDetail = `Joining ${n} segments...`;
    job.progress = 92;
    // Explicit per-file durations keep the joins exactly where the frames say.
    fs.writeFileSync(listFile, segFiles.map((f, i) => {
      const fps = fpsByInput.get(parts[i].input);
      const len = parts[i].seg.out - parts[i].seg.in;
      const exact = fps ? Math.max(1, Math.round(len * fps)) / fps : len;
      return `file '${f.replace(/'/g, "'\\''")}'\nduration ${exact.toFixed(6)}`;
    }).join("\n") + "\n");
    await execCapture("ffmpeg", ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", "-y", clipFile], { timeout: 300_000 });
  } finally {
    for (const f of [...segFiles, listFile]) await unlink(f).catch(() => {});
  }
}

// Stream a URL to disk. When the file is a fragmented MP4 (RapidAPI streams
// one), stop as soon as it covers `needSec` — the rest of the video is never
// pulled. Returns { bytes, complete, coveredSec }.
function downloadUntil(url, outFile, { needSec, job, onCovered }) {
  return new Promise((resolve, reject) => {
    const proc = execFile("curl", ["-fL", "-sS", "-o", outFile, url], { timeout: 900_000 }, (error) => {
      clearInterval(timer);
      const bytes = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
      if (stoppedEarly) return resolve({ bytes, complete: false, coveredSec });
      if (error) { error.stderr = error.stderr || error.message; return reject(error); }
      resolve({ bytes, complete: true, coveredSec: null });
    });
    let stoppedEarly = false;
    let fragmented = null;
    let coveredSec = 0;
    let probing = false;
    let lastSize = 0;
    const timer = setInterval(async () => {
      if (probing || stoppedEarly) return;
      const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
      if (job) {
        job.stageDetail = `Fetching from YouTube: ${(size / 1024 / 1024).toFixed(0)} MB${coveredSec ? ` (${Math.round(coveredSec)}s of ${Math.round(needSec)}s needed)` : ""}`;
        job.bytesPulled = size;
      }
      if (size === lastSize || size < 2_000_000) return;
      lastSize = size;
      probing = true;
      try {
        if (fragmented === null) {
          const fd = fs.openSync(outFile, "r");
          const head = Buffer.alloc(2_000_000);
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          fragmented = head.includes(Buffer.from("moof"));
          logDebug("download-until.layout", { fragmented });
        }
        if (fragmented) {
          const r = await execCapture("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outFile], { timeout: 20_000 });
          coveredSec = parseFloat(r.stdout.trim()) || 0;
          if (onCovered) onCovered(coveredSec);
          if (coveredSec >= needSec + 3) {
            stoppedEarly = true;
            proc.kill("SIGTERM");
          }
        }
      } catch {}
      probing = false;
    }, 3000);
  });
}

async function probeDuration(file) {
  try {
    const r = await execCapture("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 20_000 });
    return parseFloat(r.stdout.trim()) || null;
  } catch { return null; }
}

// Does this URL honour HTTP Range? Reads only the response headers of a
// bytes=0-1023 request, then drops the connection.
function supportsRange(url, redirects = 5) {
  return new Promise((resolve) => {
    let mod;
    try { mod = new URL(url).protocol === "http:" ? require("http") : require("https"); } catch { return resolve(false); }
    const req = mod.get(url, { headers: { Range: "bytes=0-1023" } }, (res) => {
      const { statusCode, headers } = res;
      res.destroy();
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
        return resolve(supportsRange(new URL(headers.location, url).toString(), redirects - 1));
      }
      resolve(statusCode === 206 && /^bytes /.test(headers["content-range"] || ""));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(15_000, () => { req.destroy(); resolve(false); });
  });
}

// ─── Async clip job system ──────────────────────────────────────────
const clipJobs = new Map(); // jobId → { status, progress, error, clipFile, createdAt }

// Auto-cleanup old jobs every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of clipJobs) {
    if (job.createdAt < cutoff) {
      logDebug("cleanup.delete", { jobId: id, status: job.status, ageMin: Math.round((Date.now() - job.createdAt) / 60_000), hasClipFile: !!job.clipFile });
      if (job.clipFile) unlink(job.clipFile).catch(() => {});
      clipJobs.delete(id);
    }
  }
}, 5 * 60_000);

// YouTube-sourced clip: RapidAPI direct URL → yt-dlp per-segment sections →
// yt-dlp full download. Nothing is written anywhere but /tmp, and every raw or
// segment file is deleted the moment the final clip exists.
async function processClipJob(jobId, { url, segments, quality, overlay }) {
  const job = clipJobs.get(jobId);
  if (!job) return;

  const videoId = extractVideoId(url) || "";
  const heightLimit = quality === "1080p" ? 1080 : 720;
  const clipFile = join(tmpdir(), `clip-${jobId}.mp4`);
  const rawFile = join(tmpdir(), `raw-${jobId}.mp4`);
  const fmt = `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]`;
  const n = segments.length;
  const total = segments.reduce((a, s) => a + (s.out - s.in), 0);
  const maxOut = Math.max(...segments.map((s) => s.out));
  const attempts = [];
  job.attempts = attempts;
  job.segments = segments;
  let videoMeta = null;

  const timings = { start: Date.now(), rapidapiDone: 0, downloadDone: 0, trimDone: 0 };
  const cleanupRaw = async () => {
    await unlink(rawFile).catch(() => {});
    for (let i = 1; i <= n; i++) await unlink(join(tmpdir(), `raw-${jobId}-${i}.mp4`)).catch(() => {});
  };
  // Output must be as long as the segments asked for, or the attempt failed.
  const checkOutput = async () => {
    const d = await probeDuration(clipFile);
    const want = n === 1 ? total + 0.05 : total;
    if (d == null || Math.abs(d - want) > 0.35) throw new Error(`output is ${d}s, expected ${want.toFixed(2)}s`);
    job.outputDuration = d;
  };

  try {
    logDebug("clip.start", { jobId, url, segments, total, quality: `${heightLimit}p`, rapidapi: !!RAPIDAPI_KEY });
    let downloaded = false;

    // Attempt 1: RapidAPI direct URL
    if (RAPIDAPI_KEY) {
      try {
        let downloadUrl;
        const cached = videoId && downloadUrlCache.get(`${videoId}-${heightLimit}`);
        if (cached && cached.expiresAt > Date.now()) {
          downloadUrl = cached.url;
          logDebug("rapidapi.cache-hit", { videoId });
        } else {
          job.progress = 5;
          job.stage = "resolving source";
          job.stageDetail = "RapidAPI: requesting...";
          logDebug("rapidapi.starting", { url, quality: `${heightLimit}p` });
          logClipEvent({ jobId, videoId, pipeline: "clip", step: "rapidapi-init", status: "info", detail: { quality: `${heightLimit}p` } });
          downloadUrl = await rapidApiDownload(url, quality, job);
          if (videoId) {
            downloadUrlCache.set(`${videoId}-${heightLimit}`, { url: downloadUrl, expiresAt: Date.now() + 3600_000 });
          }
        }
        timings.rapidapiDone = Date.now();
        job.progress = 30;

        const ranged = await supportsRange(downloadUrl);
        logDebug("rapidapi.range-probe", { ranged });
        logClipEvent({ jobId, videoId, pipeline: "clip", step: "download-start", status: "info", detail: { source: "rapidapi", ranged, quality: `${heightLimit}p`, segments: n } });

        if (ranged) {
          // ffmpeg seeks inside the remote file and pulls only what each segment needs.
          job.source = "rapidapi-range";
          await cutAndJoin({ jobId, job, parts: segments.map((seg) => ({ input: downloadUrl, seg })), clipFile, overlay, pipeline: "clip", videoId });
          timings.downloadDone = Date.now();
        } else {
          // No Range support: stream the file once, stop after the last needed second.
          const byTime = [...segments].sort((a, b) => a.out - b.out);
          const onCovered = (sec) => {
            const k = byTime.filter((s) => s.out <= sec).length;
            job.stage = n > 1 ? `fetching ${Math.min(n, k + 1)}/${n}` : "downloading-video";
          };
          job.stage = n > 1 ? `fetching 1/${n}` : "downloading-video";
          job.stageDetail = "Fetching from YouTube...";
          const r = await downloadUntil(downloadUrl, rawFile, { needSec: maxOut, job, onCovered });
          timings.downloadDone = Date.now();
          job.source = r.complete ? "rapidapi-full" : "rapidapi-prefix";
          job.bytesPulled = r.bytes;
          logDebug("rapidapi.fetched", { bytes: r.bytes, mb: (r.bytes / 1024 / 1024).toFixed(1), complete: r.complete, coveredSec: r.coveredSec });

          videoMeta = await getVideoMetadata(rawFile);
          if (videoMeta.warnings && videoMeta.warnings.includes("timescale not set")) {
            const remuxFile = rawFile.replace(".mp4", "-remux.mp4");
            job.stageDetail = "Re-muxing corrupt container...";
            logDebug("rapidapi.remux-start", { warnings: videoMeta.warnings.trim() });
            await execCapture("ffmpeg", ["-i", rawFile, "-c", "copy", "-y", remuxFile], { timeout: 120_000 });
            await unlink(rawFile).catch(() => {});
            fs.renameSync(remuxFile, rawFile);
          }
          const have = await probeDuration(rawFile);
          if (have != null && have < maxOut - 0.05) throw new Error(`fetched ${have}s of video, segments need ${maxOut}s`);
          job.sourceDuration = have;

          await cutAndJoin({ jobId, job, parts: segments.map((seg) => ({ input: rawFile, seg })), clipFile, overlay, videoWidth: videoMeta?.width, pipeline: "clip", videoId });
          await unlink(rawFile).catch(() => {});
        }
        await checkOutput();
        downloaded = true;
        attempts.push({ source: job.source, ok: true });
        logDebug("rapidapi.clip-success", { jobId, source: job.source });
      } catch (rapidErr) {
        attempts.push({ source: job.source || "rapidapi", ok: false, error: String(rapidErr.stderr || rapidErr.message || rapidErr).slice(0, 500) });
        logDebug("rapidapi.failed", { error: rapidErr.stderr || "", message: rapidErr.message || "" });
        await cleanupRaw();
        await unlink(clipFile).catch(() => {});
      }
    }

    // Attempt 2: yt-dlp, one --download-sections call per segment
    if (!downloaded) {
      try {
        job.progress = 30;
        job.source = "ytdlp-sections";
        const parts = [];
        for (let i = 0; i < n; i++) {
          const seg = segments[i];
          job.stage = n > 1 ? `fetching ${i + 1}/${n}` : "ytdlp-fallback";
          job.stageDetail = `yt-dlp: downloading section ${i + 1}/${n}...`;
          const out = n === 1 ? clipFile : join(tmpdir(), `raw-${jobId}-${i + 1}.mp4`);
          await execYtdlp(url, [
            url, "-f", fmt,
            "--download-sections", `*${seg.in}-${seg.out}`,
            "--force-keyframes-at-cuts",
            "--merge-output-format", "mp4", "-o", out,
          ], { timeout: 300_000, useProxy: false });
          const d = await probeDuration(out);
          parts.push({ input: out, seg: { in: 0, out: Math.min(seg.out - seg.in, d || seg.out - seg.in) } });
        }
        timings.downloadDone = Date.now();
        if (n > 1) await cutAndJoin({ jobId, job, parts, clipFile, overlay, pipeline: "clip", videoId });
        await cleanupRaw();
        if (n > 1) await checkOutput();
        downloaded = true;
        attempts.push({ source: "ytdlp-sections", ok: true });
      } catch (directErr) {
        attempts.push({ source: "ytdlp-sections", ok: false, error: String(directErr.stderr || directErr.message || directErr).slice(0, 500) });
        logDebug("clip.direct-failed", { error: directErr.stderr || directErr.message || "" });
        await cleanupRaw();
        await unlink(clipFile).catch(() => {});
      }
    }

    // Attempt 3: yt-dlp full download, then cut
    if (!downloaded) {
      job.progress = 30;
      job.source = "ytdlp-full";
      job.stage = "ytdlp-fallback";
      job.stageDetail = "yt-dlp: full download...";
      try {
        await execYtdlp(url, [url, "-f", fmt, "--merge-output-format", "mp4", "-o", rawFile], { timeout: 300_000, useProxy: false });
        timings.downloadDone = Date.now();
        job.progress = 50;
        videoMeta = await getVideoMetadata(rawFile);
        await cutAndJoin({ jobId, job, parts: segments.map((seg) => ({ input: rawFile, seg })), clipFile, overlay, videoWidth: videoMeta?.width, pipeline: "clip", videoId });
        await cleanupRaw();
        await checkOutput();
        attempts.push({ source: "ytdlp-full", ok: true });
      } catch (fullErr) {
        attempts.push({ source: "ytdlp-full", ok: false, error: String(fullErr.stderr || fullErr.message || fullErr).slice(0, 500) });
        await cleanupRaw();
        throw new Error(`All sources failed — ${attempts.map((a) => `${a.source}: ${a.error}`).join(" | ")}`);
      }
    }

    timings.trimDone = Date.now();
    const { size } = fs.statSync(clipFile);
    job.status = "ready";
    job.progress = 100;
    job.stage = "ready";
    job.stageDetail = "Ready";
    job.clipFile = clipFile;
    job.fileSize = size;
    const totalSec = (Date.now() - timings.start) / 1000;
    job.timings = { totalSec, rapidapiSec: timings.rapidapiDone ? (timings.rapidapiDone - timings.start) / 1000 : null, downloadSec: timings.downloadDone ? (timings.downloadDone - (timings.rapidapiDone || timings.start)) / 1000 : null };
    logDebug("clip.complete", { jobId, bytes: size, mb: (size / 1024 / 1024).toFixed(1), totalSec: totalSec.toFixed(1), source: job.source, segments: n });
    logClipEvent({ jobId, videoId, pipeline: "clip", step: "clip-complete", status: "success", detail: { bytes: size, mb: Number((size / 1024 / 1024).toFixed(1)), totalSec: Number(totalSec.toFixed(1)), source: job.source, segments: n, attempts } });

    logClipToBigQuery({
      job_id: jobId,
      video_id: videoId,
      video_url: url,
      start_sec: segments[0].in,
      end_sec: segments[n - 1].out,
      clip_duration_sec: total,
      quality: `${heightLimit}p`,
      status: "complete",
      error: null,
      total_sec: totalSec,
      rapidapi_sec: timings.rapidapiDone ? (timings.rapidapiDone - timings.start) / 1000 : null,
      download_sec: timings.downloadDone ? (timings.downloadDone - (timings.rapidapiDone || timings.start)) / 1000 : null,
      trim_sec: timings.trimDone ? (timings.trimDone - (timings.downloadDone || timings.start)) / 1000 : null,
      file_size_bytes: size,
      video_duration_sec: videoMeta?.duration_sec || null,
      video_resolution: videoMeta?.width ? `${videoMeta.width}x${videoMeta.height}` : null,
      created_at: new Date(timings.start).toISOString(),
    });
  } catch (error) {
    await unlink(clipFile).catch(() => {});
    await cleanupRaw();
    const detail = error.stderr || error.message || "Unknown error";
    job.status = "failed";
    job.error = detail;
    logDebug("clip.error", { jobId, url, error: detail, attempts });
    logClipEvent({ jobId, videoId, pipeline: "clip", step: "clip-failed", status: "error", detail: { error: String(detail).slice(0, 500), attempts } });

    logClipToBigQuery({
      job_id: jobId,
      video_id: videoId,
      video_url: url,
      start_sec: segments[0].in,
      end_sec: segments[n - 1].out,
      clip_duration_sec: total,
      quality: `${heightLimit}p`,
      status: "failed",
      error: String(detail).slice(0, 2000),
      total_sec: (Date.now() - timings.start) / 1000,
      rapidapi_sec: timings.rapidapiDone ? (timings.rapidapiDone - timings.start) / 1000 : null,
      download_sec: null,
      trim_sec: null,
      file_size_bytes: null,
      video_duration_sec: videoMeta?.duration_sec || null,
      video_resolution: videoMeta?.width ? `${videoMeta.width}x${videoMeta.height}` : null,
      created_at: new Date(timings.start).toISOString(),
    });
  }
}

// ─── Text overlay helper ─────────────────────────────────────────────
async function downloadGoogleFont(fontFamily) {
  const safeName = fontFamily.replace(/[^a-zA-Z0-9 ]/g, "").replace(/ /g, "_");
  const fontPath = join(tmpdir(), `font-${safeName}.ttf`);
  try {
    if (fs.existsSync(fontPath)) return fontPath;
    // Fetch CSS from Google Fonts (request with plain user-agent to get .ttf URLs)
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}`;
    const https = require("https");
    const css = await new Promise((resolve, reject) => {
      https.get(cssUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        let body = "";
        res.on("data", (c) => body += c);
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });
    // Parse .ttf URL from CSS
    const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/);
    if (!match) return null;
    execCapture("curl", ["-fL", "-o", fontPath, match[1]], { timeout: 10_000 });
    return fontPath;
  } catch {
    return null;
  }
}

function buildOverlayFilter(overlay, fontPath, videoWidth) {
  if (!overlay || !overlay.text) return null;
  const scale = (videoWidth || 1920) / 1920;
  let pos;
  if (overlay.xPct != null && overlay.yPct != null) {
    const scaledBorder = Math.round(10 * scale);
    const boxPad = overlay.bgBox ? `-${scaledBorder}` : '';
    const xOff = overlay.bgBox ? `+${scaledBorder}` : '';
    pos = `x=${overlay.xPct}*w${xOff}:y=${overlay.yPct}*h-th${boxPad}`;
  } else {
    const posMap = {
      "top-left": "x=50:y=50",
      "top-right": "x=w-tw-50:y=50",
      "bottom-left": "x=50:y=h-th-50",
      "bottom-right": "x=w-tw-50:y=h-th-50",
      "center": "x=(w-tw)/2:y=(h-th)/2",
    };
    pos = posMap[overlay.position] || posMap["bottom-left"];
  }
  const hex = (overlay.color || "#ffffff").replace("#", "");
  const opacity = Math.min(1.0, (overlay.opacity != null ? overlay.opacity : 1) * 1.1);
  const fontSize = overlay.fontSize || 48;
  const scaledFontSize = Math.round(fontSize * scale);
  const text = overlay.text.replace(/'/g, "'\\''").replace(/:/g, "\\:");
  let filter = `drawtext=text='${text}':fontsize=${scaledFontSize}:fontcolor=0x${hex}@${opacity}:${pos}`;
  if (fontPath) {
    filter += `:fontfile=${fontPath}`;
  }
  if (overlay.bgBox) {
    const bgHex = (overlay.bgColor || "#000000").replace("#", "");
    const bgAlpha = (overlay.bgOpacity != null ? overlay.bgOpacity / 100 : 0.5) * 0.9;
    const scaledBoxBorder = Math.round(10 * scale);
    filter += `:box=1:boxcolor=0x${bgHex}@${bgAlpha}:boxborderw=${scaledBoxBorder}`;
  }
  return filter;
}

// ─── GCS-based clip endpoints ────────────────────────────────────────
const GCS_BUCKET = "snippysaurus-clips";
const GCS_VIDEO_PREFIX = "videos";
const BUNNY_STREAM_API_KEY = (process.env.BUNNY_STREAM_API_KEY || "").trim();
const BUNNY_LIBRARY_ID = "627230";
const BUNNY_CDN_HOST = "vz-27263f38-8d7.b-cdn.net";
const BUNNY_REFERER = "https://iframe.mediadelivery.net/";
const GCS_PUBLIC_BASE = `https://storage.googleapis.com/${GCS_BUCKET}/${GCS_VIDEO_PREFIX}`;

app.get("/clip-gcs-check", async (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });
  try {
    const checkUrl = `${GCS_PUBLIC_BASE}/${videoId}.mp4`;
    const https = require("https");
    const http = require("http");
    const mod = checkUrl.startsWith("https") ? https : http;
    const available = await new Promise((resolve) => {
      const r = mod.request(checkUrl, { method: "HEAD" }, (resp) => {
        resolve(resp.statusCode === 200);
      });
      r.on("error", () => resolve(false));
      r.setTimeout(5000, () => { r.destroy(); resolve(false); });
      r.end();
    });
    logDebug("gcs.check", { videoId, available });
    res.json({ available, videoId, gcsUrl: available ? checkUrl : null });
  } catch (e) {
    res.json({ available: false, videoId, error: e.message });
  }
});

// Look up a video on Bunny Stream by its YouTube videoId (stored as title).
// Returns { guid, availableResolutions, status } or null if not found/ready.
async function bunnyLookup(videoId) {
  if (!BUNNY_STREAM_API_KEY) return null;
  try {
    const https = require("https");
    const data = await new Promise((resolve, reject) => {
      const req = https.request(
        `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?search=${encodeURIComponent(videoId)}&itemsPerPage=5`,
        { headers: { AccessKey: BUNNY_STREAM_API_KEY } },
        (resp) => {
          let body = "";
          resp.on("data", (c) => (body += c));
          resp.on("end", () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (!data || !Array.isArray(data.items)) return null;
    const v = data.items.find((x) => x.title === videoId && x.status >= 1);
    if (!v) return null;
    return {
      guid: v.guid,
      availableResolutions: v.availableResolutions || "",
      status: v.status,
      width: v.width,
      height: v.height,
    };
  } catch {
    return null;
  }
}

// Pick the best MP4 rendition ≤ heightLimit that Bunny actually has.
function pickBunnyRendition(availableResolutions, heightLimit) {
  const heights = (availableResolutions || "")
    .split(",")
    .map((s) => parseInt(s.trim().replace("p", ""), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  return heights.find((h) => h <= heightLimit) || heights[0] || null;
}

// Fetch a URL as text with a Referer header (Bunny gates CDN on this).
async function fetchText(url, referer) {
  const { execFile: ef } = require("child_process");
  return new Promise((resolve, reject) => {
    const args = ["-fsSL", "-H", `Referer: ${referer}`, url];
    ef("curl", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// Parse Bunny master playlist → [{height, url}].
function parseHlsMaster(text, baseUrl) {
  const out = [];
  const re = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ height: parseInt(m[2], 10), url: new URL(m[3].trim(), baseUrl).toString() });
  }
  return out;
}

// Parse a rendition playlist → [{index, startOffset, duration, url}].
function parseHlsRendition(text, baseUrl) {
  const out = [];
  const re = /#EXTINF:([\d.]+),\s*\n([^\n]+)/g;
  let m, offset = 0, i = 0;
  while ((m = re.exec(text))) {
    const dur = parseFloat(m[1]);
    const url = new URL(m[2].trim(), baseUrl).toString();
    out.push({ index: i++, startOffset: offset, duration: dur, url });
    offset += dur;
  }
  return out;
}

// Download .ts segments covering [startSec, endSec] for a Bunny video, write
// an ffmpeg concat list, and return { concatFile, segmentStartOffset, bytes }.
async function fetchBunnyHlsSegments(guid, heightLimit, startSec, endSec, scratchDir) {
  const masterUrl = `https://${BUNNY_CDN_HOST}/${guid}/playlist.m3u8`;
  const masterText = await fetchText(masterUrl, BUNNY_REFERER);
  const renditions = parseHlsMaster(masterText, masterUrl)
    .sort((a, b) => b.height - a.height);
  const picked = renditions.find((r) => r.height <= heightLimit) || renditions[renditions.length - 1];
  if (!picked) throw new Error("No rendition in master HLS playlist");

  const renditionText = await fetchText(picked.url, BUNNY_REFERER);
  const segments = parseHlsRendition(renditionText, picked.url);
  if (!segments.length) throw new Error("No segments in rendition playlist");

  const firstIdx = Math.max(0, segments.findIndex((s) => s.startOffset + s.duration > startSec));
  let lastIdx = segments.findIndex((s) => s.startOffset + s.duration >= endSec);
  if (lastIdx === -1) lastIdx = segments.length - 1;
  const covering = segments.slice(firstIdx, lastIdx + 1);
  const segmentStartOffset = covering[0].startOffset;

  fs.mkdirSync(scratchDir, { recursive: true });
  let totalBytes = 0;
  await Promise.all(covering.map(async (seg, i) => {
    const outPath = join(scratchDir, `seg${String(i).padStart(4, "0")}.ts`);
    await execCapture("curl", ["-fsSL", "-H", `Referer: ${BUNNY_REFERER}`, "-o", outPath, seg.url], { timeout: 120_000 });
    totalBytes += fs.statSync(outPath).size;
  }));

  const concatFile = join(scratchDir, "concat.txt");
  const list = covering.map((_, i) => `file '${join(scratchDir, `seg${String(i).padStart(4, "0")}.ts`).replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(concatFile, list + "\n");

  return { concatFile, segmentStartOffset, bytes: totalBytes, pickedHeight: picked.height, segmentCount: covering.length };
}

async function processGcsClipJob(jobId, { videoId, segments, quality, overlay, source }) {
  const job = clipJobs.get(jobId);
  if (!job) return;

  const n = segments.length;
  const startSec = segments[0].in;
  const endSec = segments[n - 1].out;
  job.source = source.type;
  job.segments = segments;

  const heightLimit = quality === "1080p" ? 1080 : 720;
  const clipFile = join(tmpdir(), `clip-${jobId}.mp4`);
  const srcFile = join(tmpdir(), `gcs-src-${jobId}.mp4`);
  const hlsScratchDir = join(tmpdir(), `hls-${jobId}`);
  const duration = segments.reduce((a, s) => a + (s.out - s.in), 0);

  // Resolve the source URL + any required headers.
  // `source` comes from the POST handler: { type: "bunny" | "gcs", url, referer?, guid? }.
  const srcUrl = source.url;
  const srcReferer = source.referer || null;
  // Always download the full Bunny MP4 and stream-copy trim from it. This gives a
  // bit-identical clip matching the source (which user confirmed plays smooth) with
  // no re-encode artifacts. HLS segment fetching is disabled.
  const useHlsPath = false;

  const timings = { start: Date.now(), downloadDone: 0, trimDone: 0 };

  try {
    logDebug("gcs-clip.start", { jobId, videoId, startSec, endSec, quality: `${heightLimit}p`, source: source.type, mode: useHlsPath ? "hls" : "mp4" });

    let ffmpegInputArgs; // [...input-opts, "-i", path-or-concat]
    let ffmpegSeekSec;   // -ss value (output-side for HLS, skipped for MP4 path)
    let videoMeta = null;

    if (useHlsPath) {
      // HLS path: fetch only the .ts segments covering [startSec, endSec].
      job.stage = "downloading-from-bunny-hls";
      job.stageDetail = "Fetching HLS segments...";
      job.progress = 10;
      const hls = await fetchBunnyHlsSegments(source.guid, heightLimit, startSec, endSec, hlsScratchDir);
      timings.downloadDone = Date.now();
      logDebug("gcs-clip.hls-fetched", {
        segmentCount: hls.segmentCount,
        bytes: hls.bytes,
        mb: (hls.bytes / 1024 / 1024).toFixed(1),
        pickedHeight: hls.pickedHeight,
        segmentStartOffset: hls.segmentStartOffset,
      });
      job.progress = 30;
      // Merge all covering .ts segments into one clean mp4 (copy codecs, regen timestamps)
      // to eliminate per-segment PTS/DTS discontinuities and AAC priming glitches at the
      // ~6s segment boundaries. Then input-side seek on the merged file is frame-accurate.
      const mergedFile = join(hlsScratchDir, "merged.mp4");
      job.stageDetail = "Merging HLS segments...";
      await execCapture("ffmpeg", [
        "-fflags", "+genpts",
        "-f", "concat", "-safe", "0", "-i", hls.concatFile,
        "-c", "copy", "-bsf:a", "aac_adtstoasc",
        "-movflags", "+faststart",
        "-y", mergedFile,
      ], { timeout: 300_000 });
      const mergedBytes = fs.statSync(mergedFile).size;
      logDebug("gcs-clip.hls-merged", { bytes: mergedBytes, mb: (mergedBytes / 1024 / 1024).toFixed(1) });
      job.progress = 40;
      const hlsSeek = Math.max(0, startSec - hls.segmentStartOffset);
      ffmpegInputArgs = ["-ss", String(hlsSeek), "-to", String(hlsSeek + duration + 0.05), "-i", mergedFile];
      ffmpegSeekSec = null;
      videoMeta = { width: hls.pickedHeight >= 1080 ? 1920 : hls.pickedHeight >= 720 ? 1280 : hls.pickedHeight >= 480 ? 854 : hls.pickedHeight >= 360 ? 640 : 426 };
    } else {
      // Legacy full-MP4 path (GCS or Bunny MP4 fallback).
      job.stage = source.type === "bunny" ? "downloading-from-bunny" : "downloading-from-gcs";
      job.stageDetail = source.type === "bunny" ? "Downloading from Bunny..." : "Downloading from GCS...";
      job.progress = 10;
      logDebug("gcs-clip.downloading", { srcUrl, type: source.type });
      logClipEvent({ jobId, videoId, pipeline: "clip-gcs", step: "download-start", status: "info", detail: { source: source.type, srcUrl: String(srcUrl).slice(0, 100) } });
      const curlArgs = ["-fL", "-o", srcFile];
      if (srcReferer) curlArgs.push("-H", `Referer: ${srcReferer}`);
      curlArgs.push(srcUrl);
      await execCapture("curl", curlArgs, { timeout: 600_000 });
      timings.downloadDone = Date.now();
      job.progress = 40;

      videoMeta = await getVideoMetadata(srcFile);
      if (videoMeta.warnings && videoMeta.warnings.includes("timescale not set")) {
        job.stageDetail = "Re-muxing corrupt container...";
        logDebug("gcs-clip.remux-start", { warnings: videoMeta.warnings.trim() });
        const remuxFile = srcFile.replace(".mp4", "-remux.mp4");
        await execCapture("ffmpeg", ["-i", srcFile, "-c", "copy", "-y", remuxFile], { timeout: 120_000 });
        await unlink(srcFile).catch(() => {});
        fs.renameSync(remuxFile, srcFile);
        logDebug("gcs-clip.remux-done", {});
      }
      // cutAndJoin seeks with -ss/-to before -i (fast input seek + exact AV end alignment).
    }

    // Step 3: cut (and join, for several segments) with progress
    job.progress = 50;
    logDebug("gcs-clip.ffmpeg-trim", { segments, duration, overlay: overlay?.text ? "yes" : "no", mode: useHlsPath ? "hls" : "mp4" });
    if (useHlsPath) {
      // HLS mode pre-builds its own seek args for a single range.
      const fontPath = overlay?.fontFamily ? await downloadGoogleFont(overlay.fontFamily) : null;
      const overlayFilter = buildOverlayFilter(overlay, fontPath, videoMeta?.width);
      await runFfmpeg([
        ...ffmpegInputArgs,
        "-map", "0:v:0", "-map", "0:a:0", "-dn", "-sn", "-map_chapters", "-1",
        ...(overlayFilter ? ["-vf", overlayFilter] : []),
        ...ENCODE_V,
        "-af", `afade=t=out:st=${duration}:d=0.05`,
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", "-y", clipFile,
      ], { job, duration, label: `${jobId}-hls`, onPct: (pct) => { job.stageDetail = `Trimming: ${pct}%`; } });
    } else {
      // Re-encode trim from the full Bunny MP4 with Z-settings: frame-accurate AND
      // smooth in QuickTime (2.5 Mbps cap + zerolatency avoids HW decoder stalls).
      await cutAndJoin({ jobId, job, parts: segments.map((seg) => ({ input: srcFile, seg })), clipFile, overlay, videoWidth: videoMeta?.width, pipeline: "clip-gcs", videoId });
    }
    await unlink(srcFile).catch(() => {});
    fs.rmSync(hlsScratchDir, { recursive: true, force: true });
    timings.trimDone = Date.now();

    const { size } = fs.statSync(clipFile);
    job.status = "ready";
    job.progress = 100;
    job.clipFile = clipFile;
    job.fileSize = size;
    const totalSec = (Date.now() - timings.start) / 1000;
    logDebug("gcs-clip.complete", { jobId, bytes: size, mb: (size / 1024 / 1024).toFixed(1), totalSec: totalSec.toFixed(1), route: useHlsPath ? "bunny-hls" : source.type });
    logClipEvent({ jobId, videoId, pipeline: "clip-gcs", step: "clip-complete", status: "success", detail: { bytes: size, mb: Number((size / 1024 / 1024).toFixed(1)), totalSec: Number(totalSec.toFixed(1)), route: useHlsPath ? "bunny-hls" : source.type } });

    logClipToBigQuery({
      job_id: jobId,
      video_id: videoId,
      video_url: srcUrl || null,
      start_sec: startSec,
      end_sec: endSec,
      clip_duration_sec: duration,
      quality: `${heightLimit}p`,
      status: "complete",
      error: null,
      total_sec: totalSec,
      rapidapi_sec: null,
      download_sec: timings.downloadDone ? (timings.downloadDone - timings.start) / 1000 : null,
      trim_sec: timings.trimDone ? (timings.trimDone - (timings.downloadDone || timings.start)) / 1000 : null,
      file_size_bytes: size,
      video_duration_sec: videoMeta?.duration_sec || null,
      video_resolution: videoMeta?.width ? `${videoMeta.width}x${videoMeta.height}` : null,
      created_at: new Date(timings.start).toISOString(),
    });

  } catch (error) {
    await unlink(clipFile).catch(() => {});
    await unlink(srcFile).catch(() => {});
    fs.rmSync(hlsScratchDir, { recursive: true, force: true });
    const detail = error.stderr || error.message || "Unknown error";
    job.status = "failed";
    job.error = detail;
    logDebug("gcs-clip.error", { jobId, videoId, error: detail });
    logClipEvent({ jobId, videoId, pipeline: "clip-gcs", step: "clip-failed", status: "error", detail: { error: String(detail).slice(0, 500) } });

    logClipToBigQuery({
      job_id: jobId,
      video_id: videoId,
      video_url: srcUrl || null,
      start_sec: startSec,
      end_sec: endSec,
      clip_duration_sec: duration,
      quality: `${heightLimit}p`,
      status: "failed",
      error: String(detail).slice(0, 2000),
      total_sec: (Date.now() - timings.start) / 1000,
      rapidapi_sec: null,
      download_sec: timings.downloadDone ? (timings.downloadDone - timings.start) / 1000 : null,
      trim_sec: null,
      file_size_bytes: null,
      video_duration_sec: null,
      video_resolution: null,
      created_at: new Date(timings.start).toISOString(),
    });
  }
}

function rejectClip({ pipeline, videoId, url, segments, quality, reason, extra }) {
  const rejectJobId = `reject-${crypto.randomUUID()}`;
  const first = segments && segments[0];
  const last = segments && segments[segments.length - 1];
  logClipEvent({ jobId: rejectJobId, videoId: videoId || "", pipeline, step: "clip-rejected", status: "error", detail: { reason, segments: segments || null, ...(extra || {}) } });
  logClipToBigQuery({
    job_id: rejectJobId, video_id: videoId || "", video_url: url || null,
    start_sec: first ? first.in : 0, end_sec: last ? last.out : 0,
    clip_duration_sec: segments ? segments.reduce((x, s) => x + ((s.out - s.in) || 0), 0) : 0,
    quality: quality || null, status: "rejected", error: reason,
    total_sec: 0, rapidapi_sec: null, download_sec: null, trim_sec: null,
    file_size_bytes: null, video_duration_sec: null, video_resolution: null,
    created_at: new Date().toISOString(),
  });
}

// Jobs record every stage they pass through (stageLog), so a fast stage like
// "joining" is visible after the fact even if no poll caught it live.
function newJob(extra = {}) {
  const jobId = crypto.randomUUID();
  const createdAt = Date.now();
  const job = { status: "processing", progress: 0, error: null, clipFile: null, createdAt, stageDetail: null, stageLog: [], ...extra };
  let stage = null;
  Object.defineProperty(job, "stage", {
    enumerable: true,
    get: () => stage,
    set: (v) => {
      if (v !== stage && v) job.stageLog.push({ stage: v, atSec: Number(((Date.now() - createdAt) / 1000).toFixed(1)) });
      stage = v;
    },
  });
  clipJobs.set(jobId, job);
  return jobId;
}

// Bunny MP4 (preferred) or legacy GCS copy for a video, or null.
async function resolveStoredSource(videoId, heightLimit) {
  const bunny = await bunnyLookup(videoId);
  if (bunny) {
    const pickedHeight = pickBunnyRendition(bunny.availableResolutions, heightLimit);
    if (pickedHeight) {
      logDebug("clip-gcs.source-bunny", { videoId, guid: bunny.guid, pickedHeight, requested: heightLimit, available: bunny.availableResolutions });
      return {
        type: "bunny",
        url: `https://${BUNNY_CDN_HOST}/${bunny.guid}/play_${pickedHeight}p.mp4`,
        referer: BUNNY_REFERER,
        pickedHeight,
        guid: bunny.guid,
      };
    }
  }
  const gcsUrl = `${GCS_PUBLIC_BASE}/${videoId}.mp4`;
  const https = require("https");
  const gcsAvailable = await new Promise((resolve) => {
    const r = https.request(gcsUrl, { method: "HEAD" }, (resp) => { resolve(resp.statusCode === 200); });
    r.on("error", () => resolve(false));
    r.setTimeout(5000, () => { r.destroy(); resolve(false); });
    r.end();
  });
  if (!gcsAvailable) return null;
  logDebug("clip-gcs.source-gcs", { videoId, gcsUrl });
  return { type: "gcs", url: gcsUrl };
}

app.post("/clip-gcs", async (req, res) => {
  const { videoId, quality, overlay } = req.body;
  const parsed = parseSegments(req.body);

  if (!videoId || parsed.error) {
    const reason = !videoId ? "Missing videoId" : parsed.error;
    rejectClip({ pipeline: "clip-gcs", videoId, segments: parsed.segments || req.body.segments || null, quality, reason, extra: { cap: MAX_CLIP_SEC } });
    return res.status(400).json({ error: reason });
  }
  const { segments } = parsed;

  const source = await resolveStoredSource(videoId, quality === "1080p" ? 1080 : 720);
  if (!source) return res.status(404).json({ error: "Video not available in Bunny or GCS", videoId });

  const jobId = newJob({ source: source.type, segments });
  logClipEvent({
    jobId, videoId, pipeline: "clip-gcs", step: "clip-requested", status: "info",
    detail: { segments, quality: quality || null, overlay: !!overlay, source: source.type, guid: source.guid || null },
  });

  processGcsClipJob(jobId, { videoId, segments, quality, overlay, source }).catch(() => {});

  res.json({ jobId, route: source.type });
});

// ─── Clip endpoint: Bunny for stored videos, YouTube on demand otherwise ─
// Body: { videoId | url, segments: [{in, out}] | startSec+endSec, quality,
//         overlay?, videoSource?: "bunny" | "youtube", lengthSeconds? }
// No videoSource → the original behaviour (fetch from YouTube via RapidAPI).
app.post("/clip", async (req, res) => {
  const { quality, overlay, videoSource } = req.body;
  const videoId = req.body.videoId || extractVideoId(req.body.url || "") || "";
  const url = req.body.url || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
  const parsed = parseSegments(req.body);

  if (!url || !videoId || parsed.error) {
    const reason = !url || !videoId ? "Missing url or videoId" : parsed.error;
    rejectClip({ pipeline: "clip", videoId, url, segments: parsed.segments || req.body.segments || null, quality, reason, extra: { cap: MAX_CLIP_SEC } });
    return res.status(400).json({ error: reason });
  }
  const { segments } = parsed;

  if (videoSource === "bunny") {
    const source = await resolveStoredSource(videoId, quality === "1080p" ? 1080 : 720);
    if (source) {
      const jobId = newJob({ source: source.type, segments });
      logClipEvent({ jobId, videoId, pipeline: "clip-gcs", step: "clip-requested", status: "info", detail: { segments, quality: quality || null, overlay: !!overlay, source: source.type, guid: source.guid || null } });
      processGcsClipJob(jobId, { videoId, segments, quality, overlay, source }).catch(() => {});
      return res.json({ jobId, route: source.type });
    }
    logDebug("clip.bunny-missing", { videoId });
  }

  const jobId = newJob({ segments });
  logClipEvent({
    jobId, videoId, pipeline: "clip", step: "clip-requested", status: "info",
    detail: { url: url.slice(0, 100), segments, quality: quality || null, overlay: !!overlay, videoSource: videoSource || null },
  });

  // Start background processing (don't await)
  processClipJob(jobId, { url, segments, quality, overlay }).catch(() => {});

  res.json({ jobId, route: "youtube" });
});

app.get("/clip/:jobId", (req, res) => {
  const job = clipJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status, progress: job.progress, error: job.error, fileSize: job.fileSize || null,
    stage: job.stage || null, stageDetail: job.stageDetail || null,
    source: job.source || null, segments: job.segments || null, attempts: job.attempts || null,
    bytesPulled: job.bytesPulled || null, sourceDuration: job.sourceDuration || null,
    outputDuration: job.outputDuration || null, fps: job.fps || null, timings: job.timings || null,
    stageLog: job.stageLog || null, elapsedSec: Number(((Date.now() - job.createdAt) / 1000).toFixed(1)),
  });
});

app.get("/clip/:jobId/file", async (req, res) => {
  const job = clipJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "ready") return res.status(409).json({ error: "Clip not ready" });

  try {
    const data = await readFile(job.clipFile);
    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="clip.mp4"`,
      "Content-Length": data.byteLength.toString(),
    });
    res.send(data);
  } catch (e) {
    res.status(500).json({ error: "File read failed" });
  }
});

app.get("/debug", async (_req, res) => {
  const results = { debug_events: debugEvents.length, warp_available: warpAvailable };

  // yt-dlp version
  try {
    const ytdlp = await execCapture("yt-dlp", ["--version"], { timeout: 10_000 });
    results.ytdlp = ytdlp.stdout.trim();
  } catch (e) {
    results.ytdlp = `ERROR: ${e.stderr || e.message}`;
  }

  // ffmpeg version
  try {
    const ffmpeg = await execCapture("ffmpeg", ["-version"], { timeout: 10_000 });
    results.ffmpeg = ffmpeg.stdout.split("\n")[0];
  } catch (e) {
    results.ffmpeg = `ERROR: ${e.stderr || e.message}`;
  }

  // Deno version
  try {
    const deno = await execCapture("deno", ["--version"], { timeout: 10_000 });
    results.deno = deno.stdout.split("\n")[0];
  } catch (e) {
    results.deno = `ERROR: ${e.stderr || e.message}`;
  }

  // wireproxy / WARP status (check if SOCKS5 proxy is reachable)
  try {
    const net = require("net");
    const warpCheck = await new Promise((resolve, reject) => {
      const sock = net.connect(1080, "127.0.0.1", () => {
        sock.destroy();
        resolve("reachable on :1080");
      });
      sock.on("error", reject);
      sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("timeout")); });
    });
    results.wireproxy = warpCheck;
  } catch (e) {
    results.wireproxy = `ERROR: ${e.message}`;
  }

  // bgutil PO token server
  try {
    const http = require("http");
    const potCheck = await new Promise((resolve, reject) => {
      const req = http.get("http://127.0.0.1:4416/", { timeout: 3000 }, (r) => {
        let body = "";
        r.on("data", (d) => body += d);
        r.on("end", () => resolve({ status: r.statusCode, body: body.slice(0, 200) }));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
    results.bgutil_pot_server = potCheck;
  } catch (e) {
    results.bgutil_pot_server = `ERROR: ${e.message}`;
  }

  res.json(results);
});

// Files in /tmp, optionally only those whose name contains ?match= (a jobId).
// The yt-only verifier uses this to prove no seg-*/raw-* files outlive a job.
app.get("/debug/tmp", (req, res) => {
  const match = String(req.query.match || "");
  try {
    const files = fs.readdirSync(tmpdir())
      .filter((f) => !match || f.includes(match))
      .map((f) => {
        try { const st = fs.statSync(join(tmpdir(), f)); return { name: f, bytes: st.size, mtime: st.mtime.toISOString() }; }
        catch { return { name: f }; }
      });
    res.json({ dir: tmpdir(), match: match || null, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Feasibility gate A: does the RapidAPI direct URL honour Range, and how much
// does a 45 s pull cost? ?videoId=&start=&end=&quality=
app.get("/debug/gate-a", async (req, res) => {
  const videoId = String(req.query.videoId || "");
  const start = Number(req.query.start || 252);
  const end = Number(req.query.end || 297);
  const quality = req.query.quality === "1080p" ? "1080p" : "720p";
  const heightLimit = quality === "1080p" ? 1080 : 720;
  if (!/^[\w-]{11}$/.test(videoId)) return res.status(400).json({ error: "videoId required" });
  const out = { videoId, quality, start, end };
  const t0 = Date.now();
  try {
    const cached = downloadUrlCache.get(`${videoId}-${heightLimit}`);
    let url = cached && cached.expiresAt > Date.now() ? cached.url : null;
    if (!url) {
      url = await rapidApiDownload(`https://www.youtube.com/watch?v=${videoId}`, quality, null);
      downloadUrlCache.set(`${videoId}-${heightLimit}`, { url, expiresAt: Date.now() + 3600_000 });
    }
    out.resolveSec = (Date.now() - t0) / 1000;
    out.ranged = await supportsRange(url);
    const head = await execCapture("curl", ["-sS", "-I", "--max-time", "15", url], { timeout: 20_000 }).catch((e) => ({ stdout: e.stdout || "" }));
    out.headHeaders = head.stdout.split("\n").filter((l) => /^(HTTP|accept-ranges|content-length|content-type)/i.test(l)).map((l) => l.trim());
    if (out.ranged) {
      const f = join(tmpdir(), `gate-a-${crypto.randomUUID()}.mp4`);
      const t1 = Date.now();
      const r = await execCapture("ffmpeg", ["-stats", "-ss", String(start), "-to", String(end), "-i", url, "-c", "copy", "-y", f], { timeout: 300_000 });
      out.ffmpegSec = (Date.now() - t1) / 1000;
      out.ffmpegBytes = fs.statSync(f).size;
      out.ffmpegStats = (r.stderr.match(/size=.*$/m) || [""])[0].slice(0, 200);
      await unlink(f).catch(() => {});
    }
    out.verdict = out.ranged ? "PASS: Range honoured" : "FAIL: Range ignored — exports stream the file and stop after the last needed second";
  } catch (e) {
    out.error = e.message;
  }
  res.json(out);
});

// Feasibility gate B: yt-dlp --download-sections from this box, one range.
app.get("/debug/gate-b", async (req, res) => {
  const videoId = String(req.query.videoId || "");
  const start = Number(req.query.start || 252);
  const end = Number(req.query.end || 297);
  if (!/^[\w-]{11}$/.test(videoId)) return res.status(400).json({ error: "videoId required" });
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const f = join(tmpdir(), `gate-b-${crypto.randomUUID()}.mp4`);
  const t0 = Date.now();
  const out = { videoId, start, end };
  try {
    const r = await execYtdlp(url, [
      url, "-f", "bestvideo[height<=720]+bestaudio/best[height<=720]",
      "--download-sections", `*${start}-${end}`, "--force-keyframes-at-cuts",
      "--merge-output-format", "mp4", "-o", f,
    ], { timeout: 300_000, useProxy: false });
    out.ok = true;
    out.sec = (Date.now() - t0) / 1000;
    out.bytes = fs.statSync(f).size;
    out.duration = await probeDuration(f);
    out.stderrTail = r.stderr.slice(-1500);
  } catch (e) {
    out.ok = false;
    out.sec = (Date.now() - t0) / 1000;
    out.stderrTail = String(e.stderr || e.message).slice(-1500);
  }
  await unlink(f).catch(() => {});
  res.json(out);
});

app.get("/debug/logs", (_req, res) => {
  res.json({ items: debugEvents });
});

app.get("/debug/crash", (_req, res) => {
  try { res.json({ crashLog: require("fs").readFileSync("/tmp/crash.log", "utf8") }); }
  catch { res.json({ crashLog: null }); }
});

app.get("/debug/clip-stats", async (_req, res) => {
  if (!bigquery) return res.json({ error: "BigQuery not configured" });
  try {
    const [rows] = await bigquery.query({
      query: `SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.${BQ_TABLE}\` ORDER BY created_at DESC LIMIT 2`,
    });
    const summary = {
      total: rows.length,
      completed: rows.filter((r) => r.status === "complete").length,
      failed: rows.filter((r) => r.status === "failed").length,
      avgTotalSec: rows.filter((r) => r.status === "complete" && r.total_sec).reduce((a, r) => a + r.total_sec, 0) / (rows.filter((r) => r.status === "complete").length || 1),
    };
    res.json({ summary, clips: rows });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post("/debug/logs/clear", (_req, res) => {
  debugEvents.length = 0;
  res.json({ cleared: true });
});

app.get("/debug/system", async (_req, res) => {
  const fs = require("fs");
  const os = require("os");
  const info = { ...startupState };

  // Memory & resources
  const mem = process.memoryUsage();
  info.memory = {
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    heapUsed_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal_mb: Math.round(mem.heapTotal / 1024 / 1024),
    external_mb: Math.round(mem.external / 1024 / 1024),
    totalSystem_mb: Math.round(os.totalmem() / 1024 / 1024),
    freeSystem_mb: Math.round(os.freemem() / 1024 / 1024),
  };
  info.processUptime = Math.round(process.uptime());
  info.cpus = os.cpus().length;
  info.loadAvg = os.loadavg();

  // Live port probes
  info.live = {
    socks5_1080: await probePort(1080),
    http_8080: await probePort(8080),
    bgutil_4416: await probePort(4416),
  };
  info.warpAvailable = warpAvailable;
  info.debugEventCount = debugEvents.length;

  // Read wireproxy config
  try { info.wireproxyConf = fs.readFileSync("/etc/wireproxy.conf", "utf8"); }
  catch { info.wireproxyConf = "(not found)"; }

  // yt-dlp version
  try {
    const r = await execCapture("yt-dlp", ["--version"], { timeout: 5000 });
    info.ytdlpVersion = r.stdout.trim();
  } catch (e) { info.ytdlpVersion = `error: ${e.message}`; }

  // Startup log from start.sh
  try { info.startupLog = require("fs").readFileSync("/tmp/startup.log", "utf8"); }
  catch { info.startupLog = "(not found)"; }

  // Crash log from previous runs
  try { info.crashLog = require("fs").readFileSync("/tmp/crash.log", "utf8"); }
  catch { info.crashLog = null; }

  res.json(info);
});

// Render API diagnostics
const RENDER_API_KEY = process.env.RENDER_API_KEY || "";
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || "";

app.get("/debug/render", async (_req, res) => {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    return res.json({ error: "RENDER_API_KEY or RENDER_SERVICE_ID not configured" });
  }
  const https = require("https");
  const os = require("os");

  const result = {
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      totalSystem_mb: Math.round(os.totalmem() / 1024 / 1024),
      freeSystem_mb: Math.round(os.freemem() / 1024 / 1024),
    },
    processUptime: Math.round(process.uptime()),
    cpus: os.cpus().length,
  };

  try {
    // Fetch service info
    const svcData = await new Promise((resolve, reject) => {
      https.get(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}`, {
        headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
      }, (r) => {
        let body = "";
        r.on("data", (c) => body += c);
        r.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }).on("error", reject);
    });
    result.plan = svcData.serviceDetails?.plan || "unknown";

    // Fetch recent deploys
    const deploys = await new Promise((resolve, reject) => {
      https.get(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys?limit=5`, {
        headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
      }, (r) => {
        let body = "";
        r.on("data", (c) => body += c);
        r.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }).on("error", reject);
    });
    result.deploys = deploys.map((d) => ({
      id: d.deploy?.id,
      status: d.deploy?.status,
      trigger: d.deploy?.trigger,
      commit: d.deploy?.commit?.id?.slice(0, 7),
      created: d.deploy?.createdAt,
    }));
  } catch (e) {
    result.error = e.message;
  }

  res.json(result);
});

app.get("/debug/ytdlp-plugins", async (_req, res) => {
  try {
    const result = await execCapture("yt-dlp", [
      "-v",
      "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
      "--extractor-args", "youtube:player_client=web",
      "--print", "%(id)s",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ], { timeout: 30_000 });
    res.json({ stdout: result.stdout, stderr: result.stderr });
  } catch (e) {
    res.json({ error: e.message, stdout: e.stdout || "", stderr: e.stderr || "" });
  }
});

app.get("/debug/bgutil-test", async (_req, res) => {
  try {
    const http = require("http");
    // Test the token generation endpoint directly
    const result = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({ videoId: "dQw4w9WgXcQ" });
      const req = http.request("http://127.0.0.1:4416/get_pot", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
        timeout: 15000,
      }, (r) => {
        let body = "";
        r.on("data", (d) => body += d);
        r.on("end", () => resolve({ status: r.statusCode, body: body.slice(0, 2000) }));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(postData);
      req.end();
    });
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/debug/curl-test", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });
  try {
    const result = await execCapture("curl", [
      "-fL", "-o", "/dev/null",
      "-w", '{"http_code":%{http_code},"size_download":%{size_download},"speed_download":%{speed_download},"time_total":%{time_total},"time_connect":%{time_connect},"time_starttransfer":%{time_starttransfer}}',
      "--max-time", "15",
      url,
    ], { timeout: 20_000 });
    const stats = JSON.parse(result.stdout);
    res.json({ url, ...stats, stderr: result.stderr.slice(0, 500) });
  } catch (e) {
    res.json({ url, error: e.message, stderr: (e.stderr || "").slice(0, 1000) });
  }
});

app.post("/debug/client-error", (req, res) => {
  const { error, jobId, consecutiveErrors } = req.body || {};
  logDebug("client.poll-error", { error, jobId, consecutiveErrors });
  res.json({ logged: true });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Download service running on port ${PORT}`);
  console.log(`  WARP proxy: ${WARP_PROXY}`);
});
