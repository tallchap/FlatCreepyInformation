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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Download service running on port ${PORT}`);
});
