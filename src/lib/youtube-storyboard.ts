// src/lib/youtube-storyboard.ts
// ─────────────────────────────────────────────────────────────
//  Timeline filmstrip for videos with no stored file (yt-only).
//  YouTube's watch page carries a storyboard spec: sprite sheets of small
//  frames at fixed steps. Parsed here once per video and cached; when the spec
//  can't be had, the 4 static thumbnails stand in.
// ─────────────────────────────────────────────────────────────

export interface StoryboardLevel {
  level: number;
  width: number; // one tile, px
  height: number;
  count: number; // frames in the whole video
  cols: number; // tiles per sheet row
  rows: number; // tile rows per sheet
  intervalMs: number; // time between frames
  sheets: string[]; // sprite sheet URLs in order
}

export type Storyboard =
  | { source: "storyboard"; levels: StoryboardLevel[] }
  | { source: "thumbnails"; thumbnails: string[] };

/**
 * spec = "https://i.ytimg.com/sb/ID/storyboard3_L$L/$N.jpg?sqp=…|48#27#100#10#10#0#default#rs$…|80#45#294#10#10#10000#M$M#rs$…|…"
 * Level i (0-based after the base URL) = w#h#count#cols#rows#intervalMs#name#sigh.
 */
export function parseStoryboardSpec(spec: string, durationSec?: number): StoryboardLevel[] {
  const [base, ...parts] = spec.split("|");
  if (!base || !parts.length) return [];
  const levels: StoryboardLevel[] = [];
  parts.forEach((part, level) => {
    const [w, h, count, cols, rows, interval, name, sigh] = part.split("#");
    const width = Number(w), height = Number(h), n = Number(count), c = Number(cols), r = Number(rows);
    if (![width, height, n, c, r].every((x) => Number.isFinite(x) && x > 0)) return;
    let intervalMs = Number(interval);
    if (!intervalMs && durationSec) intervalMs = Math.round((durationSec * 1000) / n);
    if (!intervalMs) return;
    const perSheet = c * r;
    const sheetCount = Math.ceil(n / perSheet);
    const sheets = Array.from({ length: sheetCount }, (_, m) => {
      const file = (name || "default").replace("$M", String(m));
      const url = base.replace("$L", String(level)).replace("$N", file);
      return sigh ? `${url}${url.includes("?") ? "&" : "?"}sigh=${sigh}` : url;
    });
    levels.push({ level, width, height, count: n, cols: c, rows: r, intervalMs, sheets });
  });
  return levels;
}

export function thumbnailFallback(videoId: string): Storyboard {
  return {
    source: "thumbnails",
    thumbnails: ["hq1", "hq2", "hq3", "hqdefault"].map((n) => `https://i.ytimg.com/vi/${videoId}/${n}.jpg`),
  };
}

const cache = new Map<string, { at: number; value: Storyboard }>();
const TTL_MS = 6 * 3600_000;

export async function fetchStoryboard(videoId: string, durationSec?: number): Promise<Storyboard> {
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: Storyboard = thumbnailFallback(videoId);
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+1; SOCS=CAI",
      },
      cache: "no-store",
    });
    const html = await res.text();
    const m = html.match(/"playerStoryboardSpecRenderer":\{"spec":"([^"]+)"/);
    if (m) {
      const spec = JSON.parse(`"${m[1]}"`) as string;
      const levels = parseStoryboardSpec(spec, durationSec);
      if (levels.length) value = { source: "storyboard", levels };
    }
  } catch {
    // keep the thumbnail fallback
  }
  // Only cache real storyboards; a miss is retried on the next request.
  if (value.source === "storyboard") cache.set(videoId, { at: Date.now(), value });
  return value;
}
