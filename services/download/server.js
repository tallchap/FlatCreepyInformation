const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { readFile, unlink, writeFile } = require("fs/promises");
const { tmpdir } = require("os");
const { join } = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const DEMO_URL = "https://www.youtube.com/watch?v=EYg3fmaycZA";
const PROXY_URL = process.env.WEBSHARE_PROXY_URL || "";
const WEBSHARE_API_TOKEN = process.env.WEBSHARE_API_TOKEN || "";

// Apify + S3 configuration
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const S3_BUCKET = process.env.S3_BUCKET || "doom-debates-videos";

const s3Configured = !!(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_REGION && S3_BUCKET);
const s3Client = s3Configured ? new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }) : null;

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

// ─── Apify + S3 helpers ─────────────────────────────────────────────

/**
 * Download a YouTube video via Apify actor into S3 and return the resulting file info.
 */
async function downloadViaApify(videoUrl, preferredQuality = "720p") {
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not configured");
  if (!s3Configured) throw new Error("AWS S3 credentials not configured");

  const actorInput = {
    videos: [{ url: videoUrl }],
    preferredQuality,
    s3AccessKeyId: AWS_ACCESS_KEY_ID,
    s3SecretAccessKey: AWS_SECRET_ACCESS_KEY,
    s3Bucket: S3_BUCKET,
    s3Region: AWS_REGION,
  };

  console.log(`[apify] Starting streamers/youtube-video-downloader for ${videoUrl}`);
  const response = await fetch(`https://api.apify.com/v2/acts/streamers~youtube-video-downloader/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&timeout=900`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(actorInput),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apify HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const items = await response.json();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Apify actor returned no items");
  }

  const item = items[0];
  if (!item.downloadedFileUrl) {
    throw new Error(`Apify actor output missing downloadedFileUrl. Keys: ${Object.keys(item).join(", ")}`);
  }

  return {
    downloadedFileUrl: item.downloadedFileUrl,
    fileKey: item.fileKey || null,
    id: item.id || null,
    raw: item,
  };
}

/**
 * Fetch an S3 object uploaded by Apify and save to local temp file.
 */
async function fetchFromS3(apifyResult) {
  if (!s3Client) throw new Error("AWS S3 credentials not configured");
  if (!apifyResult.fileKey) throw new Error("Apify output missing fileKey");
  const extMatch = apifyResult.fileKey.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : 'mp4';
  const localPath = join(tmpdir(), `s3-${crypto.randomUUID()}.${ext}`);
  const response = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: apifyResult.fileKey }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  await writeFile(localPath, buffer);
  console.log(`[s3] Downloaded ${apifyResult.fileKey} to ${localPath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  return localPath;
}

// ─── Endpoints ───────────────────────────────────────────────────────

app.post("/download", async (req, res) => {
  const url = req.body.url || DEMO_URL;
  const useApify = isYouTubeUrl(url) && !!APIFY_TOKEN && s3Configured;

  if (useApify) {
    try {
      console.log(`[download] Using Apify+S3 path for YouTube URL`);
      const apifyResult = await downloadViaApify(url, req.body.quality === "1080p" ? "1080p" : "720p");
      const localPath = await fetchFromS3(apifyResult);

      const data = await readFile(localPath);
      await unlink(localPath).catch(() => {});

      res.set({
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="video.mp4"',
        "Content-Length": data.byteLength.toString(),
      });
      return res.send(data);
    } catch (error) {
      console.error("[download] Apify+S3 failed, falling back to yt-dlp:", error.message);
      // Fall through to yt-dlp path
    }
  }

  // yt-dlp fallback (or non-YouTube URLs)
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
  const useApify = isYouTubeUrl(url) && !!APIFY_TOKEN && s3Configured;

  // Quality-based format selection (for yt-dlp fallback)
  const fmt = quality === "1080p"
    ? "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
    : "bestvideo[height<=720]+bestaudio/best[height<=720]";

  try {
    let sourceFile = null;

    if (useApify) {
      try {
        console.log(`[clip] Using Apify+S3 path for YouTube URL`);
        const apifyResult = await downloadViaApify(url, quality === "1080p" ? "1080p" : "720p");
        sourceFile = await fetchFromS3(apifyResult);
      } catch (apifyErr) {
        console.error("[clip] Apify+S3 failed, falling back to yt-dlp:", apifyErr.message);
      }
    }

    if (sourceFile) {
      // Trim the S3-downloaded file with ffmpeg
      await execCapture(
        "ffmpeg",
        [
          "-i", sourceFile,
          "-ss", String(startSec),
          "-to", String(endSec),
          "-c", "copy",
          "-movflags", "+faststart",
          clipFile,
        ],
        { timeout: 120_000 }
      );
      await unlink(sourceFile).catch(() => {});
    } else {
      // yt-dlp path (non-YouTube or Apify fallback)
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
    }

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
    apify: APIFY_TOKEN ? "configured" : "not configured",
    aws_s3: s3Configured ? "configured" : "not configured",
    s3_bucket: S3_BUCKET,
    aws_region: AWS_REGION,
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3001;

// Fetch residential proxies on startup, then start server
fetchResidentialProxies().then(() => {
  app.listen(PORT, () => {
    console.log(`Download service running on port ${PORT}`);
    console.log(`  Apify: ${APIFY_TOKEN ? "configured" : "NOT configured"}`);
    console.log(`  S3:    ${s3Configured ? "configured" : "NOT configured"} (bucket: ${S3_BUCKET})`);
  });
});
