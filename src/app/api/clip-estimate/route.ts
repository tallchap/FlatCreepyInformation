import { NextResponse } from "next/server";
import { validateSegments } from "@/lib/clip-segments";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

// POST { videoId, segments, quality } → { etaSec }: how long an export would take now.
export async function POST(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  if (validateSegments(body.segments)) return NextResponse.json({ etaSec: null });
  const r = await fetch(`${DOWNLOAD_SERVICE_URL}/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments: body.segments, quality: body.quality, videoSource: "youtube" }),
  }).catch(() => null);
  const data = r ? await r.json().catch(() => ({})) : {};
  return NextResponse.json({ etaSec: typeof data.etaSec === "number" ? data.etaSec : null, path: data.path ?? null });
}
