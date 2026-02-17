import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DOWNLOAD_SERVICE_URL = process.env.DOWNLOAD_SERVICE_URL;

export async function POST(request: Request) {
  if (!DOWNLOAD_SERVICE_URL) {
    return NextResponse.json(
      { error: "Download service not configured" },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => ({}));

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: body.url }),
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: "Download failed" },
      { status: response.status }
    );
  }

  const mp4 = Buffer.from(await response.arrayBuffer());

  return new NextResponse(mp4, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="video.mp4"',
      "Content-Length": mp4.byteLength.toString(),
    },
  });
}
