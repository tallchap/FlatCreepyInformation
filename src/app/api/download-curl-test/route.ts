import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

export async function GET(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing ?url= parameter" }, { status: 400 });
  }

  const response = await fetch(
    `${DOWNLOAD_SERVICE_URL}/debug/curl-test?url=${encodeURIComponent(url)}`,
    { method: "GET", cache: "no-store" }
  );

  const body = await response.json().catch(() => ({ error: "Curl test fetch failed" }));
  return NextResponse.json(body, { status: response.status });
}
