import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

export async function GET(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json({ error: "Download service not configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/clip/${jobId}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({ error: "Status check failed" }));
  return NextResponse.json(data, { status: response.status });
}
