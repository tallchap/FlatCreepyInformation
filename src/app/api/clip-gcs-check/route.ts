import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

export async function GET(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const videoId = searchParams.get("videoId");
  if (!videoId) return NextResponse.json({ error: "Missing videoId" }, { status: 400 });

  const response = await fetch(
    `${DOWNLOAD_SERVICE_URL}/clip-gcs-check?videoId=${encodeURIComponent(videoId)}`,
    { cache: "no-store" }
  );

  const data = await response.json().catch(() => ({ available: false }));
  return NextResponse.json(data, { status: response.status });
}
