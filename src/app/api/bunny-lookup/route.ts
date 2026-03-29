import { NextRequest, NextResponse } from "next/server";

const BUNNY_LIBRARY_ID = "627230";
const BUNNY_API_KEY = process.env.BUNNY_STREAM_API_KEY || "";

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }

  // Search Bunny Stream library for a video whose title contains the YouTube video ID
  const res = await fetch(
    `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?search=${encodeURIComponent(videoId)}&itemsPerPage=1`,
    {
      headers: { AccessKey: BUNNY_API_KEY },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    return NextResponse.json({ error: "Bunny API error" }, { status: 502 });
  }

  const data = await res.json();
  const items = data.items || [];

  if (items.length === 0) {
    return NextResponse.json({ available: false });
  }

  const video = items[0];
  // Status 4 = finished transcoding
  if (video.status !== 4) {
    return NextResponse.json({
      available: false,
      status: video.status,
      encodeProgress: video.encodeProgress,
    });
  }

  return NextResponse.json({
    available: true,
    guid: video.guid,
    libraryId: BUNNY_LIBRARY_ID,
    hlsUrl: `https://vz-27263f38-8d7.b-cdn.net/${video.guid}/playlist.m3u8`,
    embedUrl: `https://iframe.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${video.guid}`,
  });
}
