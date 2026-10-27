/** One editor URL for video titles, transcript links, and timestamped quotes. */
export function editorHref(
  videoId: string,
  start?: number | null,
  end?: number | null,
): string {
  const params = new URLSearchParams({ v: videoId });
  if (typeof start === "number" && Number.isFinite(start) && start >= 0) {
    params.set("start", String(start));
    if (typeof end === "number" && Number.isFinite(end) && end > start)
      params.set("end", String(end));
  }
  return `/edit?${params}`;
}

export type ClipRange = { in: number; out: number };

/** Old timestamped links remain usable, including YouTube's 1h2m3s form. */
export function timestampSeconds(
  raw: string | null | undefined,
): number | undefined {
  if (!raw?.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw))
    return Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  const seconds =
    match && match[0]
      ? Number(match[1] || 0) * 3600 +
        Number(match[2] || 0) * 60 +
        Number(match[3] || 0)
      : NaN;
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function readEditorRange(params: URLSearchParams): {
  range: ClipRange | null;
  hadMultiple: boolean;
} {
  const ranges = (params.get("seg") || "").split(",").flatMap((part) => {
    const m = part.trim().match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    return m &&
      Number.isFinite(Number(m[1])) &&
      Number.isFinite(Number(m[2])) &&
      Number(m[2]) > Number(m[1])
      ? [{ in: Number(m[1]), out: Number(m[2]) }]
      : [];
  });
  if (ranges.length)
    return { range: ranges[0], hadMultiple: ranges.length > 1 };
  const start = timestampSeconds(params.get("start") ?? params.get("t"));
  const end = timestampSeconds(params.get("end"));
  return {
    range:
      start === undefined
        ? null
        : {
            in: start,
            out: end !== undefined && end > start ? end : start + 10,
          },
    hadMultiple: false,
  };
}

/** Clamp a linked range or transcript selection to the real video duration. */
export function clampEditorRange(
  range: ClipRange,
  duration: number,
): ClipRange {
  const limit = duration > 0 ? duration : Infinity;
  const start = Math.max(0, Math.min(range.in, limit - 1));
  return { in: start, out: Math.min(limit, Math.max(start + 1, range.out)) };
}

/** Normalize alternate YouTube link forms emitted in chat replies. */
export function youtubeLinkTarget(
  raw: string,
): { videoId: string; startSec: number } | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^(www\.|m\.)/, "");
    const videoId =
      host === "youtu.be"
        ? url.pathname.slice(1)
        : host === "youtube.com"
          ? url.searchParams.get("v") ||
            url.pathname.match(/^\/(?:embed|shorts)\/([\w-]{11})$/)?.[1]
          : null;
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
    return {
      videoId,
      startSec:
        timestampSeconds(
          url.searchParams.get("t") ?? url.searchParams.get("start"),
        ) ?? 0,
    };
  } catch {
    return null;
  }
}
