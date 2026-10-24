import { NextResponse } from "next/server";
import { fetchVideoMeta } from "@/lib/bigquery";
import { lengthToSec, validateSegments, type ClipSegment } from "@/lib/clip-segments";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

// POST { videoId, quality, segments: [{in, out}], overlay? }
// (or the old { url | videoId, startSec, endSec } one-segment shorthand).
// The video's row decides the source: Bunny for stored videos, YouTube on
// demand for yt-only ones (and for anything Bunny turns out not to have).
export async function POST(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const { url, quality, overlay } = body;
  const videoId: string | null =
    body.videoId || (typeof url === "string" ? url.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1] : null) || null;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Missing or invalid videoId" }, { status: 400 });
  }

  let segments: ClipSegment[] | undefined = body.segments;
  if (!segments && body.startSec != null && body.endSec != null) {
    segments = [{ in: Number(body.startSec), out: Number(body.endSec) }];
  }

  const meta = await fetchVideoMeta(videoId).catch(() => undefined);
  const lengthSeconds = lengthToSec(meta?.video_length) ?? null;
  const invalid = validateSegments(segments, lengthSeconds);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoId,
      segments,
      quality: quality === "1080p" ? "1080p" : "720p",
      videoSource: meta?.video_source === "youtube" ? "youtube" : "bunny",
      lengthSeconds,
      ...(overlay ? { overlay } : {}),
    }),
  });

  const data = await response.json().catch(() => ({ error: "Clip request failed" }));
  return NextResponse.json(data, { status: response.status });
}
