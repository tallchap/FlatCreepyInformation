// A public editor export has exactly one { in, out } range (seconds).
// The array is retained for the download service wire format.

export type ClipSegment = { in: number; out: number };

export const MAX_CLIP_SEC = 11 * 60;
export const MIN_SEGMENT_SEC = 1;

/** null when valid, else the reason. `lengthSeconds` = video length, if known. */
export function validateSegments(segments: unknown, lengthSeconds?: number | null): string | null {
  if (!Array.isArray(segments) || segments.length !== 1) return "Choose exactly one clip range";
  const clip = segments[0] as ClipSegment;
  if (!clip || !Number.isFinite(clip.in) || !Number.isFinite(clip.out) || clip.in < 0) return "Clip start/end must be numbers ≥ 0";
  const duration = clip.out - clip.in;
  if (duration < MIN_SEGMENT_SEC) return `Clip must be at least ${MIN_SEGMENT_SEC} s`;
  if (lengthSeconds && clip.out > lengthSeconds + 0.5) return `Clip ends after the video (${Math.round(lengthSeconds)} s)`;
  if (duration > MAX_CLIP_SEC) return `Clip exceeds maximum length of ${MAX_CLIP_SEC / 60} minutes (${duration.toFixed(1)} s)`;
  return null;
}

/** 252 → "04:12.0"; 3725.25 → "1:02:05.3" (panel in/out). */
export function formatSegTime(sec: number): string {
  const tenths = Math.round(sec * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = (tenths % 600) / 10;
  const ss = s.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

/** 130 → "2:10.0" (panel total). */
export function formatTotal(sec: number): string {
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  return `${m}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

/** "48:48" / "1:02:03" → seconds. */
export function lengthToSec(v: unknown): number | undefined {
  if (typeof v !== "string" || !v.includes(":")) return undefined;
  const n = v.split(":").map(Number);
  if (n.some((x) => !Number.isFinite(x))) return undefined;
  return n.reduce((a, x) => a * 60 + x, 0);
}
