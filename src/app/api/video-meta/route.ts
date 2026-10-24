export const runtime = "nodejs";
export const revalidate = 3600;

import { NextRequest, NextResponse } from "next/server";
import { fetchVideoMeta } from "@/lib/bigquery";
import { fetchStoryboard } from "@/lib/youtube-storyboard";
import { lengthToSec } from "@/lib/clip-segments";

// ?videoId= → title, channel, …, video_source ('bunny' | 'youtube').
// &storyboard=1 → also YouTube storyboard sprites for the timeline filmstrip.
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({}, { status: 200 });
  }
  // Videos not in youtube_videos fall through to the retired legacy table,
  // which throws; treat that as "no metadata".
  const meta: any = (await fetchVideoMeta(videoId).catch(() => undefined)) ?? {};
  if (req.nextUrl.searchParams.get("storyboard") === "1") {
    meta.storyboard = await fetchStoryboard(videoId, lengthToSec(meta.video_length));
  }
  return NextResponse.json(meta, { status: 200 });
}
