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

const WARP_PROXY = "socks5://127.0.0.1:1080";
let warpAvailable = false;

// Check if WARP proxy is reachable at startup
setTimeout(() => {
  const net = require("net");
  const sock = net.connect(1080, "127.0.0.1", () => {
    sock.destroy();
    warpAvailable = true;
    console.log("WARP proxy detected on :1080 — will route yt-dlp through WARP");
  });
  sock.on("error", () => {
    console.log("WARP proxy not available — yt-dlp will use direct connection");
  });
  sock.setTimeout(2000, () => { sock.destroy(); });
}, 1000);

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

function ytdlpBaseArgs() {
  const args = [];
  if (warpAvailable) {
    args.push("--proxy", WARP_PROXY);
    // WARP triggers YouTube's SABR experiment on ANDROID_VR, hiding 720p+.
    // iOS client is unaffected by SABR and has full format range.
    args.push("--extractor-args", "youtube:player_client=ios,default");
  }
  args.push(
    "--sleep-interval", "5",
    "--max-sleep-interval", "10",
    "--retries", "10",
    "--retry-sleep", "5",
  );
  return args;
}

async function execYtdlp(url, args, opts = {}) {
  const fullArgs = [...ytdlpBaseArgs(), ...args];
  const start = Date.now();
  logDebug("ytdlp.exec", { args: fullArgs.join(" ") });

  try {
    const result = await execCapture("yt-dlp", fullArgs, opts);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logDebug("ytdlp.success", { elapsed: `${elapsed}s`, stderr: result.stderr.slice(0, 500) });
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

    await execYtdlp(url, [
      url,
      "-f", `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`,
      "--merge-output-format", "mp4",
      "-o", outfile,
    ], { timeout: 300_000 });

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
    console.error("Download error:", detail.slice(0, 500));
    res.status(500).json({ error: `Download failed: ${detail.slice(0, 500)}` });
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
  const heightLimit = quality === "1080p" ? 1080 : 720;
  const fmt = `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]`;

  try {
    logDebug("clip.start", { url, startSec, endSec, quality: `${heightLimit}p`, warp: warpAvailable });

    // --download-sections uses ffmpeg internally to fetch segments.
    // ffmpeg can't use SOCKS5 proxies, so when WARP is active we skip
    // straight to full download + ffmpeg trim.
    let usedFallback = warpAvailable;
    if (!usedFallback) {
      try {
        await execYtdlp(url, [
          url, "-f", fmt,
          "--download-sections", `*${startSec}-${endSec}`,
          "--force-keyframes-at-cuts",
          "--merge-output-format", "mp4",
          "-o", clipFile,
        ], { timeout: 300_000 });
      } catch (sectionsErr) {
        logDebug("clip.sections-failed", { error: (sectionsErr.stderr || sectionsErr.message || "").slice(0, 500) });
        console.log("--download-sections failed, falling back to full download + ffmpeg trim");
        usedFallback = true;
      }
    }

    if (usedFallback) {
      await execYtdlp(url, [
        url, "-f", fmt,
        "--merge-output-format", "mp4",
        "-o", rawFile,
      ], { timeout: 300_000 });

      logDebug("clip.ffmpeg-trim", { input: rawFile, startSec, endSec });
      await execCapture("ffmpeg", [
        "-i", rawFile,
        "-ss", String(startSec),
        "-to", String(endSec),
        "-c", "copy",
        "-movflags", "+faststart",
        clipFile,
      ], { timeout: 120_000 });
      await unlink(rawFile).catch(() => {});
    }

    const data = await readFile(clipFile);
    await unlink(clipFile).catch(() => {});
    logDebug("clip.complete", { bytes: data.byteLength, mb: (data.byteLength / 1024 / 1024).toFixed(1), usedFallback });

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
    logDebug("clip.error", { url, startSec, endSec, quality, error: detail.slice(0, 1000) });
    console.error("Clip error:", detail.slice(0, 500));
    res.status(500).json({ error: `Clip failed: ${detail.slice(0, 500)}` });
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
        r.on("end", () => resolve({ status: r.statusCode, body: body.slice(0, 500) }));
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
