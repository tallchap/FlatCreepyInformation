const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const { readFile, unlink, writeFile } = require("fs/promises");
const { tmpdir } = require("os");
const { join } = require("path");
const crypto = require("crypto");
const { ApifyClient } = require("apify-client");
const { S3Client, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

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

const apifyClient = APIFY_TOKEN ? new ApifyClient({ token: APIFY_TOKEN }) : null;
const s3Client = (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
  ? new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

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
 * Download a YouTube video via Apify actor into S3, return the S3 key.
 * The actor streamers/youtube-video-downloader uploads directly to S3
 * via its output, and we store the result in our bucket.
 */
async function downloadViaApify(videoUrl) {
  if (!apifyClient) throw new Error("APIFY_TOKEN not configured");
  if (!s3Client) throw new Error("AWS S3 credentials not configured");

  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error("Could not extract YouTube video ID from URL");

  const s3Key = `apify-downloads/${videoId}.mp4`;

  // Check if we already have this video in S3 (cache hit)
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    console.log(`[apify] S3 cache hit for ${videoId}`);
    return s3Key;
  } catch {
    // Not in S3 yet, proceed with download
  }

  console.log(`[apify] Starting actor run for ${videoId}...`);
  const run = await apifyClient.actor("streamers/youtube-video-downloader").call({
    urls: [videoUrl],
    quality: "highest",
  }, {
    timeoutSecs: 600,
    waitSecs: 600,
  });

  console.log(`[apify] Actor run finished: ${run.id}, status: ${run.status}`);

  if (run.status !== "SUCCEEDED") {
    throw new Error(`Apify actor run failed with status: ${run.status}`);
  }

  // Get the dataset items — actor stores download results there
  const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();

  if (!items || items.length === 0) {
    throw new Error("Apify actor returned no items");
  }

  const item = items[0];

  // The actor typically provides a download URL in the output
  // We need to download the video and upload to our S3 bucket
  const videoDownloadUrl = item.url || item.videoUrl || item.downloadUrl || item.mediaUrl;

  if (!videoDownloadUrl) {
    // Check if the actor stored the file in key-value store
    const kvStoreId = run.defaultKeyValueStoreId;
    if (kvStoreId) {
      console.log(`[apify] Checking key-value store ${kvStoreId} for video file...`);
      const store = apifyClient.keyValueStore(kvStoreId);
      // Try common key names the actor might use
      for (const key of ["OUTPUT", "video", `${videoId}.mp4`, `${videoId}`]) {
        try {
          const record = await store.getRecord(key, { buffer: true });
          if (record && record.value) {
            console.log(`[apify] Found video in KV store under key "${key}", uploading to S3...`);
            const { Upload } = require("@aws-sdk/lib-storage");
            const { S3Client: S3C } = require("@aws-sdk/client-s3");
            // Use PutObject via stream
            const { PutObjectCommand } = require("@aws-sdk/client-s3");
            await s3Client.send(new PutObjectCommand({
              Bucket: S3_BUCKET,
              Key: s3Key,
              Body: Buffer.from(record.value),
              ContentType: "video/mp4",
            }));
            console.log(`[apify] Uploaded to S3: ${s3Key}`);
            return s3Key;
          }
        } catch {
          continue;
        }
      }
    }
    throw new Error(`Apify actor output missing video URL. Keys: ${Object.keys(item).join(", ")}`);
  }

  // Download from the URL the actor provided and upload to S3
  console.log(`[apify] Downloading video from actor output URL...`);
  const https = require("https");
  const http = require("http");
  const fetchModule = videoDownloadUrl.startsWith("https") ? https : http;

  const videoBuffer = await new Promise((resolve, reject) => {
    fetchModule.get(videoDownloadUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Follow redirect
        const rmod = response.headers.location.startsWith("https") ? https : http;
        rmod.get(response.headers.location, (r2) => {
          const chunks = [];
          r2.on("data", (c) => chunks.push(c));
          r2.on("end", () => resolve(Buffer.concat(chunks)));
          r2.on("error", reject);
        }).on("error", reject);
        return;
      }
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    }).on("error", reject);
  });

  console.log(`[apify] Downloaded ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB, uploading to S3...`);
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: videoBuffer,
    ContentType: "video/mp4",
  }));

  console.log(`[apify] Uploaded to S3: ${s3Key}`);
  return s3Key;
}

/**
 * Fetch a video from S3 and save to a local temp file.
 */
async function fetchFromS3(s3Key) {
  const localPath = join(tmpdir(), `s3-${crypto.randomUUID()}.mp4`);
  const response = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));

  // Stream to file
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  await writeFile(localPath, Buffer.concat(chunks));
  console.log(`[s3] Downloaded ${s3Key} to ${localPath} (${(Buffer.concat(chunks).length / 1024 / 1024).toFixed(1)} MB)`);
  return localPath;
}

// ─── Endpoints ───────────────────────────────────────────────────────

app.post("/download", async (req, res) => {
  const url = req.body.url || DEMO_URL;
  const useApify = isYouTubeUrl(url) && apifyClient && s3Client;

  if (useApify) {
    try {
      console.log(`[download] Using Apify+S3 path for YouTube URL`);
      const s3Key = await downloadViaApify(url);
      const localPath = await fetchFromS3(s3Key);

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
  const useApify = isYouTubeUrl(url) && apifyClient && s3Client;

  // Quality-based format selection (for yt-dlp fallback)
  const fmt = quality === "1080p"
    ? "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
    : "bestvideo[height<=720]+bestaudio/best[height<=720]";

  try {
    let sourceFile = null;

    if (useApify) {
      try {
        console.log(`[clip] Using Apify+S3 path for YouTube URL`);
        const s3Key = await downloadViaApify(url);
        sourceFile = await fetchFromS3(s3Key);
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
    aws_s3: (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) ? "configured" : "not configured",
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
    console.log(`  S3:    ${s3Client ? "configured" : "NOT configured"} (bucket: ${S3_BUCKET})`);
  });
});
