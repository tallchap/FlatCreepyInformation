import ffmpegStatic from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

const CACHE_DIR = path.join(os.tmpdir(), "snippy-audio-cache");

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePathFor(bunnyUrl: string): string {
  ensureCacheDir();
  const hash = crypto.createHash("sha1").update(bunnyUrl).digest("hex").slice(0, 16);
  return path.join(CACHE_DIR, `${hash}.mp3`);
}

function lowestResBunnyUrl(url: string): string {
  // prefer 240p for audio extraction to minimize bandwidth
  return url.replace(/play_\d+p\.mp4$/, "play_240p.mp4");
}

const run = promisify(execFile);
const BUNNY_REFERER = "https://iframe.mediadelivery.net/";

function resolveFfmpegPath(): string | null {
  const direct = ffmpegStatic;
  if (direct && fs.existsSync(direct)) return direct;
  const fallback = path.join(
    process.cwd(),
    "node_modules",
    "ffmpeg-static",
    "ffmpeg"
  );
  if (fs.existsSync(fallback)) return fallback;
  const nested = path.join(
    process.cwd(),
    "FlatCreepyInformation",
    "node_modules",
    "ffmpeg-static",
    "ffmpeg"
  );
  if (fs.existsSync(nested)) return nested;
  return null;
}

const FFMPEG = resolveFfmpegPath();

const INFLIGHT = new Map<string, Promise<string>>();

async function extractFullToDiskCache(bunnyUrl: string): Promise<string> {
  if (!FFMPEG) throw new Error("ffmpeg binary not found");
  const cachePath = cachePathFor(bunnyUrl);
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1024) {
    console.log(
      `[audio] cache HIT ${cachePath} (${(fs.statSync(cachePath).size / 1024 / 1024).toFixed(1)} MB)`
    );
    return cachePath;
  }
  // If a download is already in flight for this URL, wait for it instead of
  // starting a duplicate.
  const inflight = INFLIGHT.get(bunnyUrl);
  if (inflight) {
    console.log(`[audio] awaiting in-flight download for ${bunnyUrl}`);
    return inflight;
  }
  const downloadPromise = downloadNewCache(bunnyUrl, cachePath);
  INFLIGHT.set(bunnyUrl, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    INFLIGHT.delete(bunnyUrl);
  }
}

async function downloadNewCache(bunnyUrl: string, cachePath: string): Promise<string> {
  if (!FFMPEG) throw new Error("ffmpeg binary not found");
  const lowRes = lowestResBunnyUrl(bunnyUrl);
  const tmpPath = `${cachePath}.${Date.now()}.partial`;
  const t0 = Date.now();
  console.log(`[audio] cache MISS: downloading full audio from ${lowRes}`);
  await run(
    FFMPEG,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_on_network_error",
      "1",
      "-reconnect_delay_max",
      "10",
      "-headers",
      `Referer: ${BUNNY_REFERER}\r\n`,
      "-i",
      lowRes,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      "-f",
      "mp3",
      "-y",
      tmpPath,
    ],
    { maxBuffer: 1024 * 1024 * 64, timeout: 600_000 }
  );
  fs.renameSync(tmpPath, cachePath);
  console.log(
    `[audio] cached ${(fs.statSync(cachePath).size / 1024 / 1024).toFixed(1)} MB in ${Date.now() - t0}ms`
  );
  return cachePath;
}

export async function extractAudioToMp3(
  bunnyUrl: string,
  opts?: { startSec?: number; endSec?: number }
): Promise<{
  filePath: string;
  sizeBytes: number;
  id: string;
  isCached: boolean;
}> {
  if (!FFMPEG) throw new Error("ffmpeg binary not found");
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const range =
    opts && opts.startSec != null && opts.endSec != null
      ? { startSec: opts.startSec, duration: opts.endSec - opts.startSec }
      : null;

  // Step 1: ensure full-video audio is on disk (downloads once, then cached).
  const fullAudio = await extractFullToDiskCache(bunnyUrl);

  if (!range) {
    return {
      filePath: fullAudio,
      sizeBytes: fs.statSync(fullAudio).size,
      id,
      isCached: true,
    };
  }

  // Step 2: local seek+trim from the cached full audio. Instant vs HTTP seek.
  const outPath = path.join(os.tmpdir(), `snippy-audio-${id}.mp3`);
  const t0 = Date.now();
  console.log(
    `[audio] local clip ${range.startSec}s+${range.duration}s from cache -> ${outPath}`
  );
  await run(
    FFMPEG,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      Math.max(0, range.startSec).toFixed(3),
      "-i",
      fullAudio,
      "-t",
      Math.max(0.1, range.duration).toFixed(3),
      "-c",
      "copy",
      "-y",
      outPath,
    ],
    { maxBuffer: 1024 * 1024 * 32, timeout: 60_000 }
  );

  const size = fs.statSync(outPath).size;
  console.log(
    `[audio] local clip ${(size / 1024 / 1024).toFixed(1)} MB in ${Date.now() - t0}ms`
  );
  return { filePath: outPath, sizeBytes: size, id, isCached: false };
}

// Derive duration from 64kbps constant-bitrate MP3 size.
// We encoded with `-b:a 64k` so bytes/second is effectively 8000 (64_000/8).
// Accurate to within ~1-2% which is fine for chunk boundary planning.
export function estimateDurationSec(audioPath: string): number {
  const size = fs.statSync(audioPath).size;
  const BYTES_PER_SEC_64KBPS = 8000;
  const secs = size / BYTES_PER_SEC_64KBPS;
  if (!isFinite(secs) || secs <= 0) {
    throw new Error(`Bad duration estimate: ${size} bytes`);
  }
  return secs;
}

export async function chunkAudio(
  audioPath: string,
  chunkLenSec: number,
  durationSec: number,
  id: string
): Promise<Array<{ filePath: string; offsetSec: number }>> {
  if (!FFMPEG) throw new Error("ffmpeg binary not found");
  const chunks: Array<{ filePath: string; offsetSec: number }> = [];
  const total = Math.ceil(durationSec / chunkLenSec);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const offset = i * chunkLenSec;
    const duration = Math.min(chunkLenSec, durationSec - offset);
    const outPath = path.join(
      os.tmpdir(),
      `snippy-audio-${id}-${i}.mp3`
    );
    await run(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        offset.toFixed(3),
        "-t",
        duration.toFixed(3),
        "-i",
        audioPath,
        "-c",
        "copy",
        "-y",
        outPath,
      ],
      { maxBuffer: 1024 * 1024 * 32, timeout: 120_000 }
    );
    chunks.push({ filePath: outPath, offsetSec: offset });
  }
  console.log(`[audio] ${total} chunks in ${Date.now() - t0}ms`);
  return chunks;
}

export function safeUnlink(p: string | undefined | null) {
  if (!p) return;
  fs.promises.unlink(p).catch(() => {});
}
