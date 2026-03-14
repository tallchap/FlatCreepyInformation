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

  const response = await fetch(`${DOWNLOAD_SERVICE_URL}/clip/${jobId}/file`, { cache: "no-store" });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Download failed" }));
    return NextResponse.json(err, { status: response.status });
  }

  const mp4 = Buffer.from(await response.arrayBuffer());
  return new NextResponse(mp4, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="clip.mp4"`,
      "Content-Length": mp4.byteLength.toString(),
    },
  });
}
