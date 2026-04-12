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
    // GCS fallback disabled — Bunny-only mode. Video should be created by
    // /api/trigger-download (RapidAPI → Bunny direct) before this endpoint is hit.
    // To re-enable GCS on-demand fetch, uncomment the block below.
    // const fetchRes = await fetch(
    //   `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/fetch`,
    //   {
    //     method: "POST",
    //     headers: {
    //       AccessKey: BUNNY_API_KEY,
    //       "Content-Type": "application/json",
    //     },
    //     body: JSON.stringify({
    //       url: `https://storage.googleapis.com/snippysaurus-clips/videos/${videoId}.mp4`,
    //       title: videoId,
    //     }),
    //   }
    // );
    // const fetchData = await fetchRes.json();
    // return NextResponse.json({
    //   available: false,
    //   fetching: fetchData.success || false,
    //   message: fetchData.success ? "Queued for transcoding — using GCS fallback" : "Fetch failed",
    // });
    return NextResponse.json({
      available: false,
      fetching: false,
      message: "Video not in Bunny (GCS fallback disabled)",
    });
  }

  const video = items[0];

  // With Early-Play enabled on the library, HLS serves the original file while
  // transcoding continues, so status >= 1 is playable.
  if (video.status >= 1) {
    return NextResponse.json({
      available: true,
      earlyPlay: video.status !== 4,
      guid: video.guid,
      libraryId: BUNNY_LIBRARY_ID,
      hlsUrl: `https://vz-27263f38-8d7.b-cdn.net/${video.guid}/playlist.m3u8`,
      embedUrl: `https://iframe.mediadelivery.net/embed/${BUNNY_LIBRARY_ID}/${video.guid}`,
      availableResolutions: video.availableResolutions || "",
      width: video.width,
      height: video.height,
      status: video.status,
      encodeProgress: video.encodeProgress,
    });
  }

  // Status 0 or unknown — not playable yet
  return NextResponse.json({
    available: false,
    status: video.status,
    encodeProgress: video.encodeProgress,
  });
}
