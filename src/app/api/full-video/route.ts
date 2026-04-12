import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

export async function GET(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }
  const { searchParams } = new URL(request.url);
  const videoId = searchParams.get("videoId");
  const quality = searchParams.get("quality") || "1080p";
  if (!videoId) return NextResponse.json({ error: "Missing videoId" }, { status: 400 });

  const target = `${DOWNLOAD_SERVICE_URL}/full-video?videoId=${encodeURIComponent(videoId)}&quality=${encodeURIComponent(quality)}`;
  return NextResponse.redirect(target, 302);
}
