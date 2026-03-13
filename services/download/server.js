const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const { readFile, unlink } = require("fs/promises");
const { tmpdir } = require("os");
const { join } = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const DEMO_URL = "https://www.youtube.com/watch?v=EYg3fmaycZA";
const PROXY_URL = process.env.WEBSHARE_PROXY_URL || "";
const WEBSHARE_API_TOKEN = process.env.WEBSHARE_API_TOKEN || "";

// RapidAPI YouTube Info & Download API
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_HOST = "youtube-info-download-api.p.rapidapi.com";
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}/ajax`;


const DEBUG_LOG_LIMIT = 200;
const debugEvents = [];

function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/apify_api_[A-Za-z0-9]+/g, "apify_api_[REDACTED]")
    .replace(/AKIA[0-9A-Z]+/g, "AKIA[REDACTED]")
    .replace(/([A-Za-z0-9_\-]{8,}):(\/[\/])?([A-Za-z0-9\/+_=\-]{8,})@/g, "[REDACTED]:$2[REDACTED]@")
    .replace(/e71c6f[a-f0-9]{10,}/g, "[RAPIDAPI_REDACTED]");
}

function logDebug(stage, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    stage,
    details: JSON.parse(JSON.stringify(details, (_k, v) => typeof v === "string" ? redact(v) : v)),
  };
  debugEvents.push(entry);
  if (debugEvents.length > DEBUG_LOG_LIMIT) debugEvents.shift();
  console.log(`[debug] ${stage}`, entry.details);
  return entry;
}

function isYouTubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

// Extract YouTube video ID from URL
function extractVideoId(url) {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// Residential proxy pool — fetched from Webshare API on startup
let residentialProxies = [];
let currentProxyIndex = 0;

async function fetchResidentialProxies() {
  if (!WEBSHARE_API_TOKEN) {
    console.log("[proxy] No WEBSHARE_API_TOKEN set, using WEBSHARE_PROXY_URL fallback");
    return;
  }
  try {
    const https = require("https");
    const fetchJson = (url) => new Promise((resolve, reject) => {
      https.get(url, { headers: { Authorization: `Token ${WEBSHARE_API_TOKEN}` } }, (r) => {
        let body = "";
        r.on("data", (d) => body += d);
        r.on("end", () => resolve(JSON.parse(body)));
      }).on("error", reject);
    });

    const data = await fetchJson(
      "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page_size=25&proxy_type=residential&country_code__in=BR,FR,GB,DE,NL,JP,AU,CA"
    );
    const proxies = (data.results || []).map((p) => ({
      url: `http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`,
      country: p.country_code,
      address: p.proxy_address,
    }));
    if (proxies.length > 0) {
      residentialProxies = proxies;
      console.log(`[proxy] Loaded ${proxies.length} residential proxies (countries: ${[...new Set(proxies.map(p => p.country))].join(",")})`);
    } else {
      console.log("[proxy] No residential proxies found, using WEBSHARE_PROXY_URL fallback");
    }
  } catch (e) {
    console.error("[proxy] Failed to fetch residential proxies:", e.message);
  }
}

function getNextProxy() {
  if (residentialProxies.length > 0) {
    const proxy = residentialProxies[currentProxyIndex % residentialProxies.length];
    currentProxyIndex++;
    return proxy.url;
  }
  return PROXY_URL || "";
}

function ytdlpBaseArgs() {
  return [
    "--js-runtimes", "node",
    "--extractor-args", "youtube:player-client=mweb",
  ];
}

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

// Retry yt-dlp with different proxies on bot-detection errors
async function execYtdlpWithRetry(args, opts = {}, maxRetries = 5) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const proxy = getNextProxy();
    const fullArgs = [...ytdlpBaseArgs(), ...(proxy ? ["--proxy", proxy] : []), ...args];
    const proxyLabel = proxy ? proxy.replace(/\/\/.*@/, "//***@") : "none";
    console.log(`[yt-dlp] Attempt ${attempt + 1}/${maxRetries} via proxy ${proxyLabel}`);
    try {
      return await execCapture("yt-dlp", fullArgs, opts);
    } catch (e) {
      lastError = e;
      const stderr = e.stderr || "";
      if (stderr.includes("Sign in to confirm") || stderr.includes("bot") || stderr.includes("page needs to be reloaded") || stderr.includes("HTTP Error 403") || stderr.includes("HTTP Error 429")) {
        console.log(`[yt-dlp] Proxy ${proxyLabel} blocked by YouTube, trying next...`);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// ─── RapidAPI YouTube Download helpers ──────────────────────────────

const RAPIDAPI_HEADERS = {
  "Content-Type": "application/json",
  "x-rapidapi-host": RAPIDAPI_HOST,
  "x-rapidapi-key": RAPIDAPI_KEY,
};

function mapQualityToFormat(quality) {
  return quality === "1080p" ? "1080" : "720";
}

/**
 * Poll a RapidAPI download job until it completes or times out.
 * Returns the download_url on success.
 */
async function pollRapidAPIJob(jobId, timeoutMs = 300_000) {
  const pollInterval = 3000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${RAPIDAPI_BASE}/progress.php?id=${encodeURIComponent(jobId)}`, {
      headers: RAPIDAPI_HEADERS,
    });
    const data = await res.json();
    logDebug("rapidapi.poll", { jobId, data });

    if (data.download_url) {
      return data.download_url;
    }
    if (data.status === "failed" || data.error) {
      throw new Error(`RapidAPI job failed: ${data.error || JSON.stringify(data)}`);
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(`RapidAPI job timed out after ${timeoutMs / 1000}s`);
}

/**
 * Download a YouTube clip via RapidAPI with native start/end time extraction.
 * Returns a Buffer of the MP4 data.
 */
async function downloadClipViaRapidAPI(url, startSec, endSec, quality = "720p") {
  if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY not configured");

  const format = mapQualityToFormat(quality);
  const params = new URLSearchParams({
    format,
    url,
    start_time: String(Math.round(startSec)),
    end_time: String(Math.round(endSec)),
  });

  logDebug("rapidapi.download.request", { url, startSec, endSec, format });
  console.log(`[rapidapi] Requesting clip: ${url} [${startSec}-${endSec}] @ ${format}p`);

  const res = await fetch(`${RAPIDAPI_BASE}/download.php?${params}`, {
    headers: RAPIDAPI_HEADERS,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RapidAPI HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  logDebug("rapidapi.download.response", { data });

  if (data.download_url) {
    // Direct download URL returned immediately
    console.log(`[rapidapi] Got direct download URL`);
    const dlRes = await fetch(data.download_url);
    if (!dlRes.ok) throw new Error(`Failed to fetch download URL: HTTP ${dlRes.status}`);
    return Buffer.from(await dlRes.arrayBuffer());
  }

  if (data.id) {
    // Async job — poll for completion
    console.log(`[rapidapi] Got job ID ${data.id}, polling...`);
    const downloadUrl = await pollRapidAPIJob(data.id);
    console.log(`[rapidapi] Job complete, fetching clip`);
    const dlRes = await fetch(downloadUrl);
    if (!dlRes.ok) throw new Error(`Failed to fetch download URL: HTTP ${dlRes.status}`);
    return Buffer.from(await dlRes.arrayBuffer());
  }

  throw new Error(`Unexpected RapidAPI response: ${JSON.stringify(data).slice(0, 500)}`);
}

/**
 * Download a full YouTube video via RapidAPI.
 * Returns a Buffer of the MP4 data.
 */
async function downloadFullViaRapidAPI(url, quality = "720p") {
  if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY not configured");

  const format = mapQualityToFormat(quality);
  const params = new URLSearchParams({ format, url });

  logDebug("rapidapi.download.request", { url, format, mode: "full" });
  console.log(`[rapidapi] Requesting full video: ${url} @ ${format}p`);

  const res = await fetch(`${RAPIDAPI_BASE}/download.php?${params}`, {
    headers: RAPIDAPI_HEADERS,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RapidAPI HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  logDebug("rapidapi.download.response", { data });

  if (data.download_url) {
    const dlRes = await fetch(data.download_url);
    if (!dlRes.ok) throw new Error(`Failed to fetch download URL: HTTP ${dlRes.status}`);
    return Buffer.from(await dlRes.arrayBuffer());
  }

  if (data.id) {
    const downloadUrl = await pollRapidAPIJob(data.id);
    const dlRes = await fetch(downloadUrl);
    if (!dlRes.ok) throw new Error(`Failed to fetch download URL: HTTP ${dlRes.status}`);
    return Buffer.from(await dlRes.arrayBuffer());
  }

  throw new Error(`Unexpected RapidAPI response: ${JSON.stringify(data).slice(0, 500)}`);
}

// ─── Endpoints ───────────────────────────────────────────────────────

app.post("/download", async (req, res) => {
  const url = req.body.url || DEMO_URL;
  const useRapidAPI = isYouTubeUrl(url) && !!RAPIDAPI_KEY;

  if (useRapidAPI) {
    try {
      logDebug("download.path", { mode: "rapidapi", url });
      console.log(`[download] Using RapidAPI path for YouTube URL`);
      const data = await downloadFullViaRapidAPI(url, req.body.quality || "720p");

      res.set({
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="video.mp4"',
        "Content-Length": data.byteLength.toString(),
      });
      return res.send(data);
    } catch (error) {
      logDebug("download.rapidapi.failed", { url, error: error.message || String(error) });
      console.log(`[download] RapidAPI failed, falling back to yt-dlp: ${error.message}`);
      // fall through to yt-dlp
    }
  }

  // yt-dlp fallback
  const outfile = join(tmpdir(), `video-${crypto.randomUUID()}.mp4`);
  try {
    await execYtdlpWithRetry(
      [url, "-f", "bestvideo*+bestaudio/best", "-o", outfile],
      { timeout: 300_000 }
    );

    const data = await readFile(outfile);
    await unlink(outfile).catch(() => {});

    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="video.mp4"',
      "Content-Length": data.byteLength.toString(),
    });
    res.send(data);
  } catch (error) {
    await unlink(outfile).catch(() => {});
    const detail = error.stderr || error.message || "Unknown error";
    console.error("Download error:", detail);
    res.status(500).json({ error: `Failed to download video: ${detail}` });
  }
});

app.post("/clip", async (req, res) => {
  const { url, startSec, endSec, quality } = req.body;

  if (!url || startSec == null || endSec == null) {
    return res.status(400).json({ error: "Missing url, startSec, or endSec" });
  }

  const maxClip = 11 * 60;
  if (endSec - startSec > maxClip) {
    return res.status(400).json({ error: `Clip exceeds ${maxClip / 60} minute limit` });
  }

  const uid = crypto.randomUUID();
  const clipFile = join(tmpdir(), `clip-${uid}.mp4`);
  const rawFile = join(tmpdir(), `raw-${uid}.mp4`);
  const useRapidAPI = isYouTubeUrl(url) && !!RAPIDAPI_KEY;

  // Quality-based format selection (for yt-dlp fallback)
  const fmt = quality === "1080p"
    ? "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
    : "bestvideo[height<=720]+bestaudio/best[height<=720]";

  try {
    // Primary path: RapidAPI with native clip extraction (no ffmpeg needed)
    if (useRapidAPI) {
      try {
        logDebug("clip.path", { mode: "rapidapi", url, startSec, endSec, quality });
        console.log(`[clip] Using RapidAPI path for YouTube URL`);
        const data = await downloadClipViaRapidAPI(url, startSec, endSec, quality || "720p");

        res.set({
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="clip-${startSec}-${endSec}.mp4"`,
          "Content-Length": data.byteLength.toString(),
        });
        return res.send(data);
      } catch (rapidErr) {
        logDebug("clip.rapidapi.failed", { error: rapidErr.message });
        console.log(`[clip] RapidAPI failed, falling back to yt-dlp: ${rapidErr.message}`);
        // fall through to yt-dlp
      }
    }

    // Fallback: yt-dlp
    let usedFallback = false;
    try {
      await execYtdlpWithRetry(
        [
          url, "-f", fmt,
          "--download-sections", `*${startSec}-${endSec}`,
          "--force-keyframes-at-cuts",
          "--merge-output-format", "mp4",
          "-o", clipFile,
        ],
        { timeout: 300_000 }
      );
    } catch (sectionsErr) {
      console.log("--download-sections failed, falling back to full download:", sectionsErr.stderr?.slice(0, 500));
      usedFallback = true;

      await execYtdlpWithRetry(
        [url, "-f", fmt, "--merge-output-format", "mp4", "-o", rawFile],
        { timeout: 300_000 }
      );

      await execCapture(
        "ffmpeg",
        [
          "-i", rawFile,
          "-ss", String(startSec),
          "-to", String(endSec),
          "-c", "copy",
          "-movflags", "+faststart",
          clipFile,
        ],
        { timeout: 120_000 }
      );
    }
    if (usedFallback) await unlink(rawFile).catch(() => {});

    const data = await readFile(clipFile);
    await unlink(clipFile).catch(() => {});

    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="clip-${startSec}-${endSec}.mp4"`,
      "Content-Length": data.byteLength.toString(),
    });
    res.send(data);
  } catch (error) {
    await unlink(clipFile).catch(() => {});
    await unlink(rawFile).catch(() => {});
    const detail = error.stderr || error.message || "Unknown error";
    logDebug("clip.error", { url, startSec, endSec, quality, error: detail });
    console.error("Clip error:", detail);
    res.status(500).json({ error: `Failed to create clip: ${detail}` });
  }
});

app.get("/debug", async (_req, res) => {
  const results = {
    proxy: PROXY_URL ? "configured" : "not configured",
    webshare_api: WEBSHARE_API_TOKEN ? "configured" : "not configured",
    residential_proxies: residentialProxies.length,
    residential_countries: [...new Set(residentialProxies.map(p => p.country))],
    rapidapi: RAPIDAPI_KEY ? "configured" : "not configured",
  };
  try {
    const ytdlp = await execCapture("yt-dlp", ["--version"], { timeout: 10_000 });
    results.ytdlp = ytdlp.stdout.trim();
  } catch (e) {
    results.ytdlp = `ERROR: ${e.stderr || e.message}`;
  }
  try {
    const ffmpeg = await execCapture("ffmpeg", ["-version"], { timeout: 10_000 });
    results.ffmpeg = ffmpeg.stdout.split("\n")[0];
  } catch (e) {
    results.ffmpeg = `ERROR: ${e.stderr || e.message}`;
  }
  // Check if bgutil PO token server is reachable
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3001;

// Fetch residential proxies on startup, then start server
fetchResidentialProxies().then(() => {
  app.listen(PORT, () => {
    console.log(`Download service running on port ${PORT}`);
    console.log(`  RapidAPI: ${RAPIDAPI_KEY ? "configured" : "NOT configured"}`);
  });
});
