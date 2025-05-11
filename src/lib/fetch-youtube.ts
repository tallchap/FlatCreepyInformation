import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const exec = promisify(execFile);
const YT_URL = "https://www.youtube.com/watch?v=zjnxt5mZ1Uc"; // hard-coded

export async function getVideo(): Promise<Buffer> {
  const outfile = join(tmpdir(), `video-${Date.now()}.mp4`);

  // yt-dlp-exec bundles a static binary for every platform
  const { default: ytdlp } = await import("yt-dlp-exec");

  await exec(
    ytdlp as unknown as string,
    [YT_URL, "-f", "best", "-o", outfile],
    { maxBuffer: 10 * 1024 * 1024 }, // ignore stdout; real data goes to file
  );
  const data = await readFile(outfile);
  return data;
}
