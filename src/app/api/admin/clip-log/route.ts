import { NextRequest, NextResponse } from "next/server";
import { readActiveClips, readClipEvents, type ClipEvent } from "@/lib/pipeline-log";
import { fetchClipExports, type ClipExportRow } from "@/lib/bigquery";

export const dynamic = "force-dynamic";

function authOk(req: NextRequest): boolean {
  const expected = process.env.ADMIN_PATH_SECRET;
  if (!expected) return false;
  const key = req.nextUrl.searchParams.get("key");
  return !!key && key === expected;
}

interface MergedClipRow extends ClipExportRow {
  live?: boolean;      // true = synthesized from Redis (in-flight), false = terminal BigQuery row
  latest_step?: string;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return new NextResponse("Unauthorized", {
      status: 401,
      headers: { "X-Robots-Tag": "noindex, nofollow" },
    });
  }
  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(req.nextUrl.searchParams.get("pageSize") || "20", 10);
  const videoId = req.nextUrl.searchParams.get("videoId");

  const [bqResult, active] = await Promise.all([
    fetchClipExports({ page, pageSize, videoId: videoId || null }),
    readActiveClips(),
  ]);

  // Merge: prefer BigQuery terminal row on jobId conflict (race where BQ insert
  // lands before Redis `srem` removes the active flag).
  const bqJobIds = new Set(bqResult.rows.map((r) => r.job_id));
  const inFlight: MergedClipRow[] = active
    .filter((a) => !bqJobIds.has(a.jobId))
    .filter((a) => !videoId || a.videoId === videoId)
    .map((a) => {
      // Synthesize a ClipExportRow from Redis events.
      const reqEvent = a.events.find((e) => e.step === "clip-requested");
      const detail: any = reqEvent?.detail || {};
      return {
        job_id: a.jobId,
        video_id: a.videoId,
        video_url: detail.url || null,
        start_sec: Number(detail.startSec ?? 0),
        end_sec: Number(detail.endSec ?? 0),
        clip_duration_sec: Number(detail.endSec ?? 0) - Number(detail.startSec ?? 0),
        quality: detail.quality || null,
        status: "in-flight",
        error: null,
        total_sec: null,
        rapidapi_sec: null,
        download_sec: null,
        trim_sec: null,
        file_size_bytes: null,
        video_duration_sec: null,
        video_resolution: null,
        created_at: new Date(a.firstTs || a.ts).toISOString(),
        video_title: null,
        channel_name: null,
        speaker: null,
        live: true,
        latest_step: a.step,
      };
    });

  const merged: MergedClipRow[] = [
    ...inFlight,
    ...bqResult.rows.map((r): MergedClipRow => ({ ...r, live: false })),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  // Fetch Redis events for every jobId in the merged response (active ones plus
  // terminal ones whose Redis 24h TTL hasn't expired yet).
  const eventsByJobId: Record<string, ClipEvent[]> = {};
  await Promise.all(
    merged.map(async (row) => {
      const evs = await readClipEvents(row.job_id);
      if (evs.length) eventsByJobId[row.job_id] = evs;
    }),
  );

  // Total = BigQuery total + in-flight count not already in BQ.
  const total = bqResult.total + inFlight.length;

  return NextResponse.json(
    {
      rows: merged,
      events: eventsByJobId,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      total,
    },
    { headers: { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" } },
  );
}
