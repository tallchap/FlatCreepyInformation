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

async function processClipJob(jobId, { url, startSec, endSec, quality, overlay }) {
  const job = clipJobs.get(jobId);
  if (!job) return;

  const heightLimit = quality === "1080p" ? 1080 : 720;
  const clipFile = join(tmpdir(), `clip-${jobId}.mp4`);
  let videoMeta = null;
  const rawFile = join(tmpdir(), `raw-${jobId}.mp4`);
  const fmt = `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]`;

  const timings = { start: Date.now(), rapidapiDone: 0, downloadDone: 0, trimDone: 0 };

  try {
    logDebug("clip.start", { jobId, url, startSec, endSec, quality: `${heightLimit}p`, rapidapi: !!RAPIDAPI_KEY });
    let downloaded = false;

    // Attempt 1: RapidAPI (no timeout limit — runs in background)
    if (RAPIDAPI_KEY) {
      try {
        const videoId = extractVideoId(url);
        let downloadUrl;

        const cached = videoId && downloadUrlCache.get(`${videoId}-${heightLimit}`);
        if (cached && cached.expiresAt > Date.now()) {
          downloadUrl = cached.url;
          logDebug("rapidapi.cache-hit", { videoId });
        } else {
          job.progress = 5;
          job.stage = "rapidapi-processing";
          job.stageDetail = "RapidAPI: requesting...";
          logDebug("rapidapi.starting", { url, quality: `${heightLimit}p` });
          downloadUrl = await rapidApiDownload(url, quality, job);
          if (videoId) {
            downloadUrlCache.set(`${videoId}-${heightLimit}`, {
              url: downloadUrl, expiresAt: Date.now() + 3600_000,
            });
          }
        }
        timings.rapidapiDone = Date.now();

        job.progress = 70;
        job.stage = "downloading-video";
        job.stageDetail = "Downloading video...";
        const duration = endSec - startSec;
        const rapidRaw = join(tmpdir(), `rapid-raw-${jobId}.mp4`);
        logDebug("rapidapi.downloading", { downloadUrl: downloadUrl.slice(0, 80), startSec, duration });

        // Step 1: curl downloads full video to disk (handles HTTPS; static ffmpeg uses GnuTLS, can't)
        await execCapture("curl", ["-fL", "-o", rapidRaw, downloadUrl], { timeout: 600_000 });
        timings.downloadDone = Date.now();

        // Grab source video metadata before trimming
        videoMeta = await getVideoMetadata(rapidRaw);

        // Re-mux if container is corrupt (e.g. timescale not set)
        if (videoMeta.warnings && videoMeta.warnings.includes("timescale not set")) {
          const remuxStart = Date.now();
          const remuxFile = rapidRaw.replace(".mp4", "-remux.mp4");
          job.stageDetail = "Re-muxing corrupt container...";
          logDebug("rapidapi.remux-start", { warnings: videoMeta.warnings.trim() });
          await execCapture("ffmpeg", ["-i", rapidRaw, "-c", "copy", "-y", remuxFile], { timeout: 120_000 });
          await unlink(rapidRaw).catch(() => {});
          require("fs").renameSync(remuxFile, rapidRaw);
          logDebug("rapidapi.remux-done", { ms: Date.now() - remuxStart });
        }

        // Step 2: ffmpeg trim with progress reporting
        job.stage = "trimming-clip";
        job.stageDetail = "Trimming: 0%";
        const fontPath = overlay?.fontFamily ? await downloadGoogleFont(overlay.fontFamily) : null;
        const overlayFilter = buildOverlayFilter(overlay, fontPath);
        logDebug("rapidapi.ffmpeg-trim", { startSec, duration, overlay: overlayFilter ? "yes" : "no" });
        await new Promise((resolve, reject) => {
          const args = [
            "-err_detect", "ignore_err", "-fflags", "+genpts",
            "-ss", String(startSec), "-to", String(startSec + duration), "-i", rapidRaw,
            ...(overlayFilter ? ["-vf", overlayFilter] : []),
            "-c:v", "libx264", "-b:v", "2500k", "-maxrate", "2700k", "-bufsize", "5000k", "-preset", "fast", "-tune", "zerolatency",
            "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-bf", "0", "-refs", "1",
            "-af", `afade=t=out:st=${Math.max(0, duration - 0.05)}:d=0.05`,
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart", "-y", clipFile,
          ];
          const proc = execFile("ffmpeg", args, (error) => {
            clearInterval(stallCheck);
            if (error) { error.stderr = lastLines.join("\n"); reject(error); }
            else resolve();
          });
          const lastLines = [];
          let lastLoggedPct = -1;
          let lastEncodedSecs = 0;
          let previousCheckSecs = -1;
          // Stall detection: every 5 min, compare progress. If unchanged, kill.
          const stallCheck = setInterval(() => {
            if (lastEncodedSecs === previousCheckSecs) {
              logDebug("rapidapi.ffmpeg-stalled", { lastEncodedSecs, pct: job?.stageDetail });
              proc.kill();
            }
            previousCheckSecs = lastEncodedSecs;
          }, 300_000);
          if (proc.stderr) proc.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            // Keep last 10 lines for error reporting
            const lines = text.split("\n").filter(l => l.trim());
            lines.forEach(l => { lastLines.push(l); if (lastLines.length > 10) lastLines.shift(); });
            // Parse time= for progress
            const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (match && duration > 0) {
              const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
              lastEncodedSecs = secs;
              const pct = Math.min(99, Math.round((secs / duration) * 100));
              if (job) job.stageDetail = `Trimming: ${pct}%`;
              // Log at 10% intervals
              const bucket = Math.floor(pct / 10) * 10;
              if (bucket > 0 && bucket > lastLoggedPct) {
                lastLoggedPct = bucket;
                logDebug("rapidapi.ffmpeg-progress", { pct: `${bucket}%`, time: `${match[1]}:${match[2]}:${match[3]}` });
              }
            }
          });
        });
        await unlink(rapidRaw).catch(() => {});
        downloaded = true;
        logDebug("rapidapi.clip-success", { jobId });
      } catch (rapidErr) {
        logDebug("rapidapi.failed", { error: rapidErr.stderr || "", message: rapidErr.message || "" });
      }
    }

    // Attempt 2: yt-dlp direct with --download-sections
    if (!downloaded) {
      try {
        job.progress = 30;
        job.stage = "ytdlp-fallback";
        job.stageDetail = "yt-dlp: downloading section...";
        await execYtdlp(url, [
          url, "-f", fmt,
          "--download-sections", `*${startSec}-${endSec}`,
          "--force-keyframes-at-cuts",
          "--merge-output-format", "mp4", "-o", clipFile,
        ], { timeout: 300_000, useProxy: false });
        downloaded = true;
      } catch (directErr) {
        logDebug("clip.direct-failed", { error: directErr.stderr || directErr.message || "" });
      }
    }

    // Attempt 3: yt-dlp full download + ffmpeg trim
    if (!downloaded) {
      job.progress = 30;
      job.stage = "ytdlp-fallback";
      job.stageDetail = "yt-dlp: full download...";
      await execYtdlp(url, [
        url, "-f", fmt, "--merge-output-format", "mp4", "-o", rawFile,
      ], { timeout: 300_000, useProxy: false });

      job.progress = 80;
      const duration = endSec - startSec;
      await execCapture("ffmpeg", [
        "-err_detect", "ignore_err", "-fflags", "+genpts",
        "-ss", String(startSec), "-to", String(endSec), "-i", rawFile,
        "-c:v", "libx264", "-b:v", "2500k", "-maxrate", "2700k", "-bufsize", "5000k", "-preset", "fast", "-tune", "zerolatency",
        "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-bf", "0", "-refs", "1",
        "-af", `afade=t=out:st=${Math.max(0, duration - 0.05)}:d=0.05`,
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", clipFile,
      ], { timeout: 300_000 });
      await unlink(rawFile).catch(() => {});
    }

    timings.trimDone = Date.now();
    const { size } = require("fs").statSync(clipFile);
    job.status = "ready";
    job.progress = 100;
    job.clipFile = clipFile;
    job.fileSize = size;
    const totalSec = (Date.now() - timings.start) / 1000;
    logDebug("clip.complete", { jobId, bytes: size, mb: (size / 1024 / 1024).toFixed(1), totalSec: totalSec.toFixed(1) });

    logClipToBigQuery({
      job_id: jobId,
      video_id: extractVideoId(url) || "",
      video_url: url,
      start_sec: startSec,
      end_sec: endSec,
      clip_duration_sec: endSec - startSec,
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
    await unlink(rawFile).catch(() => {});
    const detail = error.stderr || error.message || "Unknown error";
    job.status = "failed";
    job.error = detail;
    logDebug("clip.error", { jobId, url, error: detail });

    logClipToBigQuery({
      job_id: jobId,
      video_id: extractVideoId(url) || "",
      video_url: url,
      start_sec: startSec,
      end_sec: endSec,
      clip_duration_sec: endSec - startSec,
      quality: `${heightLimit}p`,
      status: "failed",
      error: detail.slice(0, 2000),
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

async function processGcsClipJob(jobId, { videoId, startSec, endSec, quality, overlay, source }) {
  const job = clipJobs.get(jobId);
  if (!job) return;

  const heightLimit = quality === "1080p" ? 1080 : 720;
  const clipFile = join(tmpdir(), `clip-${jobId}.mp4`);
  const srcFile = join(tmpdir(), `gcs-src-${jobId}.mp4`);
  const hlsScratchDir = join(tmpdir(), `hls-${jobId}`);
  const duration = endSec - startSec;

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
      ffmpegInputArgs = ["-ss", String(hlsSeek), "-to", String(hlsSeek + duration), "-i", mergedFile];
      ffmpegSeekSec = null;
      videoMeta = { width: hls.pickedHeight >= 1080 ? 1920 : hls.pickedHeight >= 720 ? 1280 : hls.pickedHeight >= 480 ? 854 : hls.pickedHeight >= 360 ? 640 : 426 };
    } else {
      // Legacy full-MP4 path (GCS or Bunny MP4 fallback).
      job.stage = source.type === "bunny" ? "downloading-from-bunny" : "downloading-from-gcs";
      job.stageDetail = source.type === "bunny" ? "Downloading from Bunny..." : "Downloading from GCS...";
      job.progress = 10;
      logDebug("gcs-clip.downloading", { srcUrl, type: source.type });
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
      // Legacy seek: -ss and -to before -i (fast input seek + exact AV end alignment).
      ffmpegInputArgs = ["-err_detect", "ignore_err", "-fflags", "+genpts", "-ss", String(startSec), "-to", String(endSec), "-i", srcFile];
      ffmpegSeekSec = null;
    }

    // Step 3: ffmpeg trim with progress
    job.stage = "trimming-clip";
    job.stageDetail = "Trimming: 0%";
    job.progress = 50;
    const fontPath = overlay?.fontFamily ? await downloadGoogleFont(overlay.fontFamily) : null;
    const overlayFilter = buildOverlayFilter(overlay, fontPath, videoMeta?.width);
    logDebug("gcs-clip.ffmpeg-trim", { startSec, duration, overlay: overlayFilter ? "yes" : "no", mode: useHlsPath ? "hls" : "mp4" });
    await new Promise((resolve, reject) => {
      // Stream-copy trim: no re-encode, bit-identical to source, guaranteed smooth playback.
      // -ss on input seeks to nearest keyframe before startSec (Bunny = 1s GOP, so ≤1s earlier).
      // Overlay and audio fade are not compatible with -c copy and are intentionally dropped.
      const args = [
        ...ffmpegInputArgs,
        "-c", "copy", "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart", "-y", clipFile,
      ];
      const proc = execFile("ffmpeg", args, (error) => {
        clearInterval(stallCheck);
        if (error) { error.stderr = lastLines.join("\n"); reject(error); }
        else resolve();
      });
      const lastLines = [];
      let lastLoggedPct = -1;
      let lastEncodedSecs = 0;
      let previousCheckSecs = -1;
      const stallCheck = setInterval(() => {
        if (lastEncodedSecs === previousCheckSecs) {
          logDebug("gcs-clip.ffmpeg-stalled", { lastEncodedSecs, pct: job?.stageDetail });
          proc.kill();
        }
        previousCheckSecs = lastEncodedSecs;
      }, 300_000);
      if (proc.stderr) proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        const lines = text.split("\n").filter(l => l.trim());
        lines.forEach(l => { lastLines.push(l); if (lastLines.length > 10) lastLines.shift(); });
        const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (match && duration > 0) {
          const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
          lastEncodedSecs = secs;
          const pct = Math.min(99, Math.round((secs / duration) * 100));
          if (job) job.stageDetail = `Trimming: ${pct}%`;
          const bucket = Math.floor(pct / 10) * 10;
          if (bucket > 0 && bucket > lastLoggedPct) {
            lastLoggedPct = bucket;
            logDebug("gcs-clip.ffmpeg-progress", { pct: `${bucket}%`, time: `${match[1]}:${match[2]}:${match[3]}` });
          }
        }
      });
    });
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

  } catch (error) {
    await unlink(clipFile).catch(() => {});
    await unlink(srcFile).catch(() => {});
    fs.rmSync(hlsScratchDir, { recursive: true, force: true });
    const detail = error.stderr || error.message || "Unknown error";
    job.status = "failed";
    job.error = detail;
    logDebug("gcs-clip.error", { jobId, videoId, error: detail });
  }
}

app.post("/clip-gcs", async (req, res) => {
  const { videoId, startSec, endSec, quality, overlay } = req.body;

  if (!videoId || startSec == null || endSec == null) {
    return res.status(400).json({ error: "Missing videoId, startSec, or endSec" });
  }

  const maxClip = 11 * 60;
  if (endSec - startSec > maxClip) {
    return res.status(400).json({ error: `Clip exceeds ${maxClip / 60} minute limit` });
  }

  // Resolve source: try Bunny first, fall back to GCS for legacy videos.
  const https = require("https");
  const heightLimit = quality === "1080p" ? 1080 : 720;

  let source = null;

  const bunny = await bunnyLookup(videoId);
  if (bunny) {
    const pickedHeight = pickBunnyRendition(bunny.availableResolutions, heightLimit);
    if (pickedHeight) {
      source = {
        type: "bunny",
        url: `https://${BUNNY_CDN_HOST}/${bunny.guid}/play_${pickedHeight}p.mp4`,
        referer: BUNNY_REFERER,
        pickedHeight,
        guid: bunny.guid,
      };
      logDebug("clip-gcs.source-bunny", { videoId, guid: bunny.guid, pickedHeight, requested: heightLimit, available: bunny.availableResolutions });
    }
  }

  if (!source) {
    const gcsUrl = `${GCS_PUBLIC_BASE}/${videoId}.mp4`;
    const gcsAvailable = await new Promise((resolve) => {
      const r = https.request(gcsUrl, { method: "HEAD" }, (resp) => { resolve(resp.statusCode === 200); });
      r.on("error", () => resolve(false));
      r.setTimeout(5000, () => { r.destroy(); resolve(false); });
      r.end();
    });
    if (!gcsAvailable) {
      return res.status(404).json({ error: "Video not available in Bunny or GCS", videoId });
    }
    source = { type: "gcs", url: gcsUrl };
    logDebug("clip-gcs.source-gcs", { videoId, gcsUrl });
  }

  const jobId = crypto.randomUUID();
  clipJobs.set(jobId, { status: "processing", progress: 0, error: null, clipFile: null, createdAt: Date.now(), stage: null, stageDetail: null });

  processGcsClipJob(jobId, { videoId, startSec, endSec, quality, overlay, source }).catch(() => {});

  res.json({ jobId, route: source.type });
});

// ─── RapidAPI-realtime clip endpoint (original) ─────────────────────
app.post("/clip", async (req, res) => {
  const { url, startSec, endSec, quality, overlay } = req.body;

  if (!url || startSec == null || endSec == null) {
    return res.status(400).json({ error: "Missing url, startSec, or endSec" });
  }

  const maxClip = 11 * 60;
  if (endSec - startSec > maxClip) {
    return res.status(400).json({ error: `Clip exceeds ${maxClip / 60} minute limit` });
  }

  const jobId = crypto.randomUUID();
  clipJobs.set(jobId, { status: "processing", progress: 0, error: null, clipFile: null, createdAt: Date.now(), stage: null, stageDetail: null });

  // Start background processing (don't await)
  processClipJob(jobId, { url, startSec, endSec, quality, overlay }).catch(() => {});

  res.json({ jobId });
});

app.get("/clip/:jobId", (req, res) => {
  const job = clipJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress, error: job.error, fileSize: job.fileSize || null, stage: job.stage || null, stageDetail: job.stageDetail || null });
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

// Stream the full-length Bunny MP4 rendition to the client as a download.
// No re-encode. Bunny → Render → user. Supports Range requests.
app.get("/full-video", async (req, res) => {
  const videoId = String(req.query.videoId || "");
  const quality = String(req.query.quality || "1080p");
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const heightLimit = quality === "1080p" ? 1080 : 720;
  const bunny = await bunnyLookup(videoId).catch(() => null);
  if (!bunny) return res.status(404).json({ error: "Video not in Bunny" });
  const pickedHeight = pickBunnyRendition(bunny.availableResolutions, heightLimit);
  if (!pickedHeight) return res.status(404).json({ error: "No rendition available" });

  const upstreamUrl = `https://${BUNNY_CDN_HOST}/${bunny.guid}/play_${pickedHeight}p.mp4`;
  const filename = `${videoId}-${pickedHeight}p.mp4`;

  const https = require("https");
  const headers = { Referer: BUNNY_REFERER };
  if (req.headers.range) headers.Range = req.headers.range;

  logDebug("full-video.start", { videoId, quality: `${pickedHeight}p`, range: req.headers.range || null });

  const upstream = https.get(upstreamUrl, { headers }, (upRes) => {
    if (upRes.statusCode >= 400) {
      res.status(upRes.statusCode).json({ error: `Upstream ${upRes.statusCode}` });
      upRes.resume();
      return;
    }
    res.status(upRes.statusCode);
    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Accept-Ranges": "bytes",
    });
    if (upRes.headers["content-length"]) res.set("Content-Length", upRes.headers["content-length"]);
    if (upRes.headers["content-range"]) res.set("Content-Range", upRes.headers["content-range"]);
    upRes.pipe(res);
    upRes.on("end", () => logDebug("full-video.done", { videoId, bytes: upRes.headers["content-length"] || "?" }));
  });
  upstream.on("error", (err) => {
    logDebug("full-video.error", { videoId, err: err.message });
    if (!res.headersSent) res.status(502).json({ error: "Upstream fetch failed" });
  });
  req.on("close", () => { try { upstream.destroy(); } catch (_) {} });
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
