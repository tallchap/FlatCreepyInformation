export const runtime = "nodejs";
export const revalidate = 3600;

import { NextRequest, NextResponse } from "next/server";
import { fetchVideoMeta } from "@/lib/bigquery";

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({}, { status: 200 });
  }
  const meta = await fetchVideoMeta(videoId);
  return NextResponse.json(meta ?? {}, { status: 200 });
}
