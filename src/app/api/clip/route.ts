import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;
const MAX_CLIP_SEC = 11 * 60;

export async function POST(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json(
      { error: "Download service not configured" },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const { url, startSec, endSec, quality } = body;

  if (!url || startSec == null || endSec == null) {
    return NextResponse.json(
      { error: "Missing required fields: url, startSec, endSec" },
      { status: 400 },
    );
  }

  if (endSec - startSec > MAX_CLIP_SEC) {
    return NextResponse.json(
      { error: `Clip exceeds maximum length of ${MAX_CLIP_SEC / 60} minutes` },
      { status: 400 },
    );
  }

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, startSec, endSec, quality: quality || "720p" }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Clip failed" }));
    return NextResponse.json(
      { error: err.error || "Clip failed" },
      { status: response.status },
    );
  }

  const mp4 = Buffer.from(await response.arrayBuffer());

  return new NextResponse(mp4, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="clip-${startSec}-${endSec}.mp4"`,
      "Content-Length": mp4.byteLength.toString(),
    },
  });
}
