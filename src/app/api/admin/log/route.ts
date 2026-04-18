import { NextRequest, NextResponse } from "next/server";
import { readEvents, type PipelineEvent } from "@/lib/pipeline-log";
import { fetchTranscribeLog } from "@/lib/bigquery";

export const dynamic = "force-dynamic";

function authOk(req: NextRequest): boolean {
  const expected = process.env.ADMIN_PATH_SECRET;
  if (!expected) return false;
  const key = req.nextUrl.searchParams.get("key");
  return !!key && key === expected;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return new NextResponse("Unauthorized", { status: 401, headers: { "X-Robots-Tag": "noindex, nofollow" } });
  }
  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(req.nextUrl.searchParams.get("pageSize") || "20", 10);
  const videoId = req.nextUrl.searchParams.get("videoId");

  const { rows, total } = await fetchTranscribeLog({ page, pageSize, videoId: videoId || null });

  const uniqueIds = Array.from(new Set(rows.map((r) => r.video_id)));
  const eventsByVideo: Record<string, PipelineEvent[]> = {};
  await Promise.all(
    uniqueIds.map(async (id) => {
      const res = await readEvents({ page: 1, pageSize: 100, videoId: id });
      eventsByVideo[id] = res.events;
    }),
  );

  return NextResponse.json(
    {
      rows,
      events: eventsByVideo,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      total,
    },
    { headers: { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" } },
  );
}
