import { NextRequest, NextResponse } from "next/server";

const BUNNY_LIBRARY_ID = "627230";
const BUNNY_API_KEY = process.env.BUNNY_STREAM_API_KEY || "";
const BUNNY_CDN_HOST = "vz-27263f38-8d7.b-cdn.net";

export async function GET(req: NextRequest) {
  if (!BUNNY_API_KEY) {
    return NextResponse.json(
      { error: "BUNNY_STREAM_API_KEY not configured" },
      { status: 500 }
    );
  }

  const search = req.nextUrl.searchParams.get("search") || "";
  const page = req.nextUrl.searchParams.get("page") || "1";
  const itemsPerPage = req.nextUrl.searchParams.get("itemsPerPage") || "50";

  const qs = new URLSearchParams({
    page,
    itemsPerPage,
    orderBy: "date",
  });
  if (search) qs.set("search", search);

  const res = await fetch(
    `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?${qs}`,
    {
      headers: { AccessKey: BUNNY_API_KEY },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Bunny API ${res.status}`, detail: text.slice(0, 200) },
      { status: 502 }
    );
  }

  const data = await res.json();
  const items = (data.items || []).map((v: {
    guid: string;
    title: string;
    length: number;
    width: number;
    height: number;
    status: number;
    encodeProgress: number;
    availableResolutions?: string;
    thumbnailFileName?: string;
    dateUploaded?: string;
  }) => {
    const playable = v.status >= 1;
    const resolutions = (v.availableResolutions || "").split(",").filter(Boolean);
    const preferred =
      resolutions.find((r) => r === "1080p") ||
      resolutions.find((r) => r === "720p") ||
      resolutions[0] ||
      "";
    const mp4Url = playable && preferred
      ? `https://${BUNNY_CDN_HOST}/${v.guid}/play_${preferred}.mp4`
      : null;
    const hlsUrl = playable
      ? `https://${BUNNY_CDN_HOST}/${v.guid}/playlist.m3u8`
      : null;
    const thumbUrl = v.thumbnailFileName
      ? `https://${BUNNY_CDN_HOST}/${v.guid}/${v.thumbnailFileName}`
      : null;
    return {
      guid: v.guid,
      title: v.title,
      length: v.length,
      width: v.width,
      height: v.height,
      status: v.status,
      encodeProgress: v.encodeProgress,
      availableResolutions: v.availableResolutions || "",
      dateUploaded: v.dateUploaded,
      playable,
      mp4Url,
      hlsUrl,
      thumbUrl,
    };
  });

  return NextResponse.json({
    items,
    totalItems: data.totalItems ?? items.length,
    currentPage: data.currentPage ?? Number(page),
    itemsPerPage: data.itemsPerPage ?? Number(itemsPerPage),
  });
}
