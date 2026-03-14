import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

export async function GET() {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/debug/logs`, {
    method: "GET",
    cache: "no-store",
  });

  const body = await response.json().catch(() => ({ error: "Debug fetch failed" }));
  return NextResponse.json(body, { status: response.status });
}

export async function DELETE() {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/debug/logs/clear`, {
    method: "POST",
    cache: "no-store",
  });

  const body = await response.json().catch(() => ({ error: "Clear failed" }));
  return NextResponse.json(body, { status: response.status });
}
