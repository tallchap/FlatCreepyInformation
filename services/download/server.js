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

    // Get residential proxies, prefer non-US countries (less likely flagged by YouTube)
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

function proxyArgs() {
  const proxy = getNextProxy();
  return proxy ? ["--proxy", proxy] : [];
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
      // Non-proxy error, don't retry
      throw e;
    }
  }
  throw lastError;
}

app.post("/download", async (req, res) => {
  const url = req.body.url || DEMO_URL;
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

  // Quality-based format selection
  const fmt = quality === "1080p"
    ? "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
    : "bestvideo[height<=720]+bestaudio/best[height<=720]";

  try {
    // Try optimized path: yt-dlp --download-sections to grab only the clip portion
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

      // Fallback: full download + ffmpeg trim
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

    const data = await readFile(clipFile);
    await unlink(clipFile).catch(() => {});
    if (usedFallback) await unlink(rawFile).catch(() => {});

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
  });
});
