import ffmpegStaticPath from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const run = promisify(execFile);
const BUNNY_REFERER = "https://iframe.mediadelivery.net/";
const PRE_ROLL_SEC = 0.5;

function resolveFfmpegPath(): string | null {
  const direct = ffmpegStaticPath;
  if (direct && fs.existsSync(direct)) return direct;
  // Next.js / Turbopack mangles __dirname to "/ROOT/..." — fall back to cwd-relative
  const fallback = path.join(
    process.cwd(),
    "node_modules",
    "ffmpeg-static",
    "ffmpeg"
  );
  if (fs.existsSync(fallback)) return fallback;
  // Worktree / monorepo case: try the repo's own node_modules
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

export interface PretrimResult {
  filePath: string;
  clipId: string;
  preRollSec: number;
}

export async function pretrimToLocal(
  sourceUrl: string,
  startSec: number,
  endSec: number
): Promise<PretrimResult> {
  if (!FFMPEG) throw new Error("ffmpeg binary not found in node_modules/ffmpeg-static");
  if (endSec <= startSec) throw new Error("endSec must be greater than startSec");

  const clipId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outPath = path.join(os.tmpdir(), `snippy-src-${clipId}.mp4`);

  const preRoll = Math.min(startSec, PRE_ROLL_SEC);
  const seekFrom = Math.max(0, startSec - preRoll);
  const clipDurationWithPreRoll = endSec - seekFrom;

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_on_http_error", "4xx,5xx",
    "-reconnect_delay_max", "10",
    "-rw_timeout", "60000000",
    "-headers", `Referer: ${BUNNY_REFERER}\r\n`,
    "-ss", seekFrom.toFixed(3),
    "-i", sourceUrl,
    "-t", clipDurationWithPreRoll.toFixed(3),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-y",
    outPath,
  ];

  const t0 = Date.now();
  console.log(`[pretrim] ffmpeg ${seekFrom}s + ${clipDurationWithPreRoll}s -> ${outPath}`);
  try {
    const { stderr } = await run(FFMPEG, args, {
      maxBuffer: 1024 * 1024 * 64,
      timeout: 280_000,
    });
    if (stderr && stderr.trim()) {
      console.log(`[pretrim] ffmpeg stderr: ${stderr.trim().slice(0, 500)}`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = (e.stderr || "").toString().trim();
    const stdout = (e.stdout || "").toString().trim();
    const killed = (e as { killed?: boolean }).killed;
    const signal = (e as { signal?: string }).signal;
    console.error(
      `[pretrim] ffmpeg failed: code=${e.code} signal=${signal} killed=${killed}\nstderr: ${stderr.slice(0, 800)}\nstdout: ${stdout.slice(0, 400)}`
    );
    throw new Error(
      `ffmpeg pretrim failed (${e.code || signal || "unknown"}). ${stderr.slice(0, 400) || "No stderr — check server logs."}`
    );
  }
  console.log(`[pretrim] done in ${Date.now() - t0}ms`);

  return { filePath: outPath, clipId, preRollSec: preRoll };
}

export function safeUnlink(p: string): void {
  fs.promises.unlink(p).catch(() => {});
}
