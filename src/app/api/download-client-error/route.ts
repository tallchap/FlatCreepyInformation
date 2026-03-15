import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

export async function POST(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/debug/client-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);

  if (!response) {
    return NextResponse.json({ error: "Failed to reach download service" }, { status: 502 });
  }

  const data = await response.json().catch(() => ({ error: "Parse failed" }));
  return NextResponse.json(data, { status: response.status });
}
