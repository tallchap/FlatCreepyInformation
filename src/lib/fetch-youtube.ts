// src/lib/fetch-youtube.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import YTDlpWrap from "yt-dlp-wrap";

/* --------------------------------------------------------- *
 *  CONFIG — hard-coded URL for the About-page demo button   *
 *  (You can pass a dynamic URL from the API route instead.) *
 * --------------------------------------------------------- */
const DEMO_URL = "https://www.youtube.com/watch?v=zjnxt5mZ1Uc";

/**
 * Download <url> with yt-dlp and return the resulting MP4 bytes.
 */
export async function getVideo(url: string = DEMO_URL): Promise<Buffer> {
  const outfile = join(tmpdir(), `video-${randomUUID()}.mp4`);

  // 1) spawn yt-dlp
  const ytdlp = new YTDlpWrap();
  await new Promise<void>((resolve, reject) => {
    ytdlp
      .exec([
        url,
        "-f",
        "bestvideo*+bestaudio/best", // the usual quality logic
        "-o",
        outfile,
      ])
      .on("error", reject)
      .on("close", () => resolve());
  });

  // 2) read the file into memory and clean up
  const data = await readFile(outfile);
  await unlink(outfile).catch(() => {
    /* ignore if already removed */
  });
  return data;
}
