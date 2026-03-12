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

app.post("/download", async (req, res) => {
  const url = req.body.url || DEMO_URL;
  const outfile = join(tmpdir(), `video-${crypto.randomUUID()}.mp4`);

  try {
    await new Promise((resolve, reject) => {
      const proc = execFile(
        "yt-dlp",
        [url, "-f", "bestvideo*+bestaudio/best", "-o", outfile],
        { timeout: 300_000 },
        (error) => (error ? reject(error) : resolve())
      );
    });

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
    console.error("Download error:", error);
    res.status(500).json({ error: "Failed to download video" });
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
  const rawFile = join(tmpdir(), `raw-${uid}.mp4`);
  const clipFile = join(tmpdir(), `clip-${uid}.mp4`);

  // Quality-based format selection
  const fmt = quality === "1080p"
    ? "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
    : "bestvideo[height<=720]+bestaudio/best[height<=720]";

  try {
    // Step 1: Download with yt-dlp
    await new Promise((resolve, reject) => {
      execFile(
        "yt-dlp",
        [url, "-f", fmt, "--merge-output-format", "mp4", "-o", rawFile],
        { timeout: 300_000 },
        (error) => (error ? reject(error) : resolve())
      );
    });

    // Step 2: Trim with ffmpeg (stream copy for speed)
    await new Promise((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-i", rawFile,
          "-ss", String(startSec),
          "-to", String(endSec),
          "-c", "copy",
          "-movflags", "+faststart",
          clipFile,
        ],
        { timeout: 120_000 },
        (error) => (error ? reject(error) : resolve())
      );
    });

    const data = await readFile(clipFile);
    await unlink(rawFile).catch(() => {});
    await unlink(clipFile).catch(() => {});

    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="clip-${startSec}-${endSec}.mp4"`,
      "Content-Length": data.byteLength.toString(),
    });
    res.send(data);
  } catch (error) {
    await unlink(rawFile).catch(() => {});
    await unlink(clipFile).catch(() => {});
    console.error("Clip error:", error);
    res.status(500).json({ error: "Failed to create clip" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Download service running on port ${PORT}`);
});
