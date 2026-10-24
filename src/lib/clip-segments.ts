// Multi-range clips: a clip is a list of { in, out } ranges (seconds) joined
// in the order given. Shared by the editor, /api/clip and the verifier.

export type ClipSegment = { in: number; out: number };

export const MAX_CLIP_SEC = 11 * 60;
export const MAX_SEGMENTS = 20;
export const MIN_SEGMENT_SEC = 1;

export function totalLength(segments: ClipSegment[]): number {
  return segments.reduce((a, s) => a + (s.out - s.in), 0);
}

/** null when valid, else the reason. `lengthSeconds` = video length, if known. */
export function validateSegments(segments: unknown, lengthSeconds?: number | null): string | null {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > MAX_SEGMENTS) {
    return `A clip needs 1–${MAX_SEGMENTS} segments`;
  }
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as ClipSegment;
    if (!s || !Number.isFinite(s.in) || !Number.isFinite(s.out) || s.in < 0) return `Segment ${i + 1}: in/out must be numbers ≥ 0`;
    if (s.out - s.in < MIN_SEGMENT_SEC) return `Segment ${i + 1} is shorter than ${MIN_SEGMENT_SEC} s`;
    if (lengthSeconds && s.out > lengthSeconds + 0.5) return `Segment ${i + 1} ends after the video (${Math.round(lengthSeconds)} s)`;
  }
  const total = totalLength(segments as ClipSegment[]);
  if (total > MAX_CLIP_SEC) return `Clip exceeds maximum length of ${MAX_CLIP_SEC / 60} minutes (total ${total.toFixed(1)} s)`;
  return null;
}

/** "252-297,1110.5-1160.5" → segments (invalid pieces dropped). */
export function parseSegParam(param: string | null | undefined): ClipSegment[] {
  if (!param) return [];
  return param
    .split(",")
    .map((p) => p.trim().match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ in: Number(m[1]), out: Number(m[2]) }))
    .filter((s) => s.out > s.in);
}

export function segParam(segments: ClipSegment[]): string {
  const n = (x: number) => String(Math.round(x * 1000) / 1000);
  return segments.map((s) => `${n(s.in)}-${n(s.out)}`).join(",");
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
