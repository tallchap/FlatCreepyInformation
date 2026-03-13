const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// RapidAPI YouTube Info & Download API
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_HOST = "youtube-info-download-api.p.rapidapi.com";
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}/ajax`;

const DEBUG_LOG_LIMIT = 200;
const debugEvents = [];

function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/e71c6f[a-f0-9]{10,}/g, "[RAPIDAPI_REDACTED]")
    .replace(/([A-Za-z0-9_\-]{8,}):(\/[\/])?([A-Za-z0-9\/+_=\-]{8,})@/g, "[REDACTED]:$2[REDACTED]@");
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
 * Poll a RapidAPI download job using the direct progress URL.
 * Returns the download_url on success.
 */
async function pollRapidAPIJob(progressUrl, timeoutMs = 300_000) {
  const pollInterval = 3000;
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    attempt++;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    try {
      const res = await fetch(progressUrl);
      const data = await res.json();
      logDebug("rapidapi.poll", { attempt, elapsed: `${elapsed}s`, httpStatus: res.status, progressUrl, data });

      if (data.download_url) {
        return data.download_url;
      }
      if (data.status === "failed" || data.error) {
        throw new Error(`RapidAPI job failed: ${data.error || JSON.stringify(data)}`);
      }
    } catch (err) {
      if (err.message?.includes("RapidAPI job failed")) throw err;
      logDebug("rapidapi.poll.error", { attempt, elapsed: `${elapsed}s`, progressUrl, error: err.message });
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(`RapidAPI job timed out after ${timeoutMs / 1000}s`);
}

/**
 * Fetch a download URL and return its contents as a Buffer.
 * Logs byte count on completion.
 */
async function fetchDownloadUrl(downloadUrl) {
  logDebug("rapidapi.fetch.start", { downloadUrl });
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) throw new Error(`Failed to fetch download: HTTP ${dlRes.status}`);
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  logDebug("rapidapi.fetch.complete", { bytes: buffer.byteLength, mb: (buffer.byteLength / 1024 / 1024).toFixed(1) });
  return buffer;
}

/**
 * Handle the RapidAPI download response: either direct URL or async job polling.
 */
async function handleRapidAPIResponse(data) {
  if (data.download_url) {
    console.log(`[rapidapi] Got direct download URL`);
    return fetchDownloadUrl(data.download_url);
  }

  if (data.id) {
    const progressUrl = data.progress_url || `https://p.savenow.to/api/progress?id=${data.id}`;
    logDebug("rapidapi.poll.start", { jobId: data.id, progressUrl });
    console.log(`[rapidapi] Got job ID ${data.id}, polling ${progressUrl}`);
    const downloadUrl = await pollRapidAPIJob(progressUrl);
    console.log(`[rapidapi] Job complete, fetching clip`);
    return fetchDownloadUrl(downloadUrl);
  }

  throw new Error(`Unexpected RapidAPI response: ${JSON.stringify(data).slice(0, 500)}`);
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
  logDebug("rapidapi.download.httpStatus", { status: res.status, statusText: res.statusText });
  if (!res.ok) {
    const text = await res.text();
    logDebug("rapidapi.download.httpError", { status: res.status, body: text.slice(0, 500) });
    throw new Error(`RapidAPI HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  logDebug("rapidapi.download.response", { data });

  return handleRapidAPIResponse(data);
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
  logDebug("rapidapi.download.httpStatus", { status: res.status, statusText: res.statusText });
  if (!res.ok) {
    const text = await res.text();
    logDebug("rapidapi.download.httpError", { status: res.status, body: text.slice(0, 500) });
    throw new Error(`RapidAPI HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  logDebug("rapidapi.download.response", { data });

  return handleRapidAPIResponse(data);
}

// ─── Endpoints ───────────────────────────────────────────────────────

app.post("/download", async (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: "Missing url" });
  if (!RAPIDAPI_KEY) return res.status(503).json({ error: "RAPIDAPI_KEY not configured" });

  try {
    logDebug("download.path", { mode: "rapidapi", url });
    const data = await downloadFullViaRapidAPI(url, req.body.quality || "720p");

    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="video.mp4"',
      "Content-Length": data.byteLength.toString(),
    });
    res.send(data);
  } catch (error) {
    logDebug("download.error", { url, error: error.message || String(error) });
    console.error("Download error:", error.message);
    res.status(500).json({ error: `Download failed: ${error.message}` });
  }
});

app.post("/clip", async (req, res) => {
  const { url, startSec, endSec, quality } = req.body;

  if (!url || startSec == null || endSec == null) {
    return res.status(400).json({ error: "Missing url, startSec, or endSec" });
  }
  if (!RAPIDAPI_KEY) {
    return res.status(503).json({ error: "RAPIDAPI_KEY not configured" });
  }

  const maxClip = 11 * 60;
  if (endSec - startSec > maxClip) {
    return res.status(400).json({ error: `Clip exceeds ${maxClip / 60} minute limit` });
  }

  try {
    logDebug("clip.path", { mode: "rapidapi", url, startSec, endSec, quality });
    const data = await downloadClipViaRapidAPI(url, startSec, endSec, quality || "720p");

    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="clip-${startSec}-${endSec}.mp4"`,
      "Content-Length": data.byteLength.toString(),
    });
    res.send(data);
  } catch (error) {
    logDebug("clip.error", { url, startSec, endSec, quality, error: error.message || String(error) });
    console.error("Clip error:", error.message);
    res.status(500).json({ error: `Clip failed: ${error.message}` });
  }
});

app.get("/debug", async (_req, res) => {
  res.json({
    rapidapi: RAPIDAPI_KEY ? "configured" : "not configured",
    debug_events: debugEvents.length,
  });
});

app.get("/debug/logs", (_req, res) => {
  res.json({ items: debugEvents });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Download service running on port ${PORT}`);
  console.log(`  RapidAPI: ${RAPIDAPI_KEY ? "configured" : "NOT configured"}`);
});
