const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process"); // v3
const { readFile, unlink } = require("fs/promises");
const { tmpdir } = require("os");
const { join } = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

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
  const STALL_TIMEOUT = 240_000; // 4 minutes without progress change = stalled
  let pollCount = 0;
  let lastProgress = null;
  let lastProgressValue = -1;
  let lastProgressChangeTime = Date.now();

  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    pollCount++;
    const progress = await new Promise((resolve, reject) => {
      https.get(progressUrl, (res) => {
        let body = "";
        res.on("data", (c) => body += c);
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }).on("error", reject);
    });
    lastProgress = progress;

    // Track progress changes for stall detection
    if (progress.progress !== lastProgressValue) {
      lastProgressValue = progress.progress;
      lastProgressChangeTime = Date.now();
    }

    // Update job stage for frontend visibility
    if (job) {
      job.stage = "rapidapi-processing";
      job.stageDetail = `RapidAPI: ${progress.progress}% — ${progress.text || "processing"}`;
    }

    // Log every 10 polls (~20s)
    if (pollCount % 10 === 0) {
      logDebug("rapidapi.polling", { progress: progress.progress, text: progress.text, pollCount, elapsed: `${pollCount * 2}s` });
    }

    if (progress.success === 1 && progress.download_url) {
      logDebug("rapidapi.ready", { download_url: progress.download_url, pollCount, elapsed: `${pollCount * 2}s` });
      return progress.download_url;
    }
    if (progress.text === "Error" || progress.progress < 0) {
      throw new Error(`RapidAPI processing failed: ${progress.text}`);
    }
    // Stall detection: if progress hasn't changed in 2 minutes, give up
    if (Date.now() - lastProgressChangeTime > STALL_TIMEOUT) {
      logDebug("rapidapi.stalled", { lastProgress, pollCount, elapsed: `${pollCount * 2}s`, stalledAt: lastProgressValue });
      throw new Error(`RapidAPI stalled at ${lastProgressValue}% for 4min. Last: ${JSON.stringify(lastProgress)}`);
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
      if (job.clipFile) unlink(job.clipFile).catch(() => {});
      clipJobs.delete(id);
    }
  }
}, 5 * 60_000);

async function processClipJob(jobId, { url, startSec, endSec, quality }) {
  const job = clipJobs.get(jobId);
  if (!job) return;

  const heightLimit = quality === "1080p" ? 1080 : 720;
  const clipFile = join(tmpdir(), `clip-${jobId}.mp4`);
  const rawFile = join(tmpdir(), `raw-${jobId}.mp4`);
  const fmt = `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]`;

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

        job.progress = 70;
        job.stage = "trimming-clip";
        job.stageDetail = "Seeking & trimming clip...";
        const duration = endSec - startSec;
        logDebug("rapidapi.ffmpeg-trim", { downloadUrl: downloadUrl.slice(0, 80), startSec, duration });

        // Use ffmpeg directly on the URL — -ss after -i for stream seeking
        // (-ss before -i fails: HTTP byte-range seek produces empty output)
        // -tls_verify 0 bypasses CA cert issues with static ffmpeg builds
        await execCapture("ffmpeg", [
          "-tls_verify", "0",
          "-i", downloadUrl,
          "-ss", String(startSec),
          "-t", String(duration),
          "-c:v", "libx264", "-crf", "18", "-preset", "fast",
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart", "-y", clipFile,
        ], { timeout: 300_000 });
        downloaded = true;
        logDebug("rapidapi.clip-success", { jobId });
      } catch (rapidErr) {
        logDebug("rapidapi.failed", { error: (rapidErr.stderr || "").slice(0, 2000), message: (rapidErr.message || "").slice(0, 500) });
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
        logDebug("clip.direct-failed", { error: (directErr.stderr || directErr.message || "").slice(0, 2000) });
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
        "-ss", String(startSec), "-i", rawFile,
        "-t", String(duration),
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", clipFile,
      ], { timeout: 300_000 });
      await unlink(rawFile).catch(() => {});
    }

    const { size } = require("fs").statSync(clipFile);
    job.status = "ready";
    job.progress = 100;
    job.clipFile = clipFile;
    job.fileSize = size;
    logDebug("clip.complete", { jobId, bytes: size, mb: (size / 1024 / 1024).toFixed(1) });
  } catch (error) {
    await unlink(clipFile).catch(() => {});
    await unlink(rawFile).catch(() => {});
    const detail = error.stderr || error.message || "Unknown error";
    job.status = "failed";
    job.error = detail.slice(0, 2000);
    logDebug("clip.error", { jobId, url, error: detail.slice(0, 1000) });
  }
}

app.post("/clip", async (req, res) => {
  const { url, startSec, endSec, quality } = req.body;

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
  processClipJob(jobId, { url, startSec, endSec, quality }).catch(() => {});

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

app.post("/debug/logs/clear", (_req, res) => {
  debugEvents.length = 0;
  res.json({ cleared: true });
});

app.get("/debug/system", async (_req, res) => {
  const fs = require("fs");
  const info = { ...startupState };

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
  try { info.startupLog = fs.readFileSync("/tmp/startup.log", "utf8"); }
  catch { info.startupLog = "(not found)"; }

  res.json(info);
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Download service running on port ${PORT}`);
  console.log(`  WARP proxy: ${WARP_PROXY}`);
});
