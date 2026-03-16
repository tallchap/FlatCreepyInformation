import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

export async function POST(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/clip-gcs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({ error: "GCS clip request failed" }));
  return NextResponse.json(data, { status: response.status });
}
