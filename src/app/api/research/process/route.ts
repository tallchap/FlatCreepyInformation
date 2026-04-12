import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS } from "@/lib/bigquery-schema";
import { runPipeline } from "@/lib/research-pipeline";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

const CONCURRENCY = 20;

export async function POST(req: NextRequest) {
  try {
    const { runId, videoIds, speaker } = await req.json();

    if (!runId || !videoIds?.length || !speaker) {
      return NextResponse.json(
        { error: "Missing runId, videoIds, or speaker" },
        { status: 400 }
      );
    }

    // Load cached transcripts + metadata for all videos in one query
    const [candidateRows] = await bigQuery.query({
      query: `
        SELECT video_id, title, channel, channel_id, duration_seconds, published_at, description, thumbnail_url, transcript_json
        FROM ${TABLE_REFS.researchCandidates}
        WHERE run_id = @runId AND video_id IN UNNEST(@videoIds)
      `,
      params: { runId, videoIds },
    });
    const transcriptCache = new Map<string, any>();
    const metadataCache = new Map<string, any>();
    for (const row of candidateRows) {
      if (row.transcript_json) {
        try {
          const sanitized = row.transcript_json.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
          transcriptCache.set(row.video_id, JSON.parse(sanitized));
        } catch {}
      }
      metadataCache.set(row.video_id, {
        title: row.title,
        channel: row.channel,
        channel_id: row.channel_id,
        duration_seconds: row.duration_seconds,
        published_at: row.published_at,
        description: row.description,
        thumbnail_url: row.thumbnail_url,
      });
    }
    console.log(
      `[research/process] ${transcriptCache.size}/${videoIds.length} videos have cached transcripts`
    );

    // Mark all as queued via streaming inserts to log table (no DML limit)
    const logTable = bigQuery.dataset("reptranscripts").table("research_processing_log");
    const logRows = videoIds.map((vid) => ({
      run_id: runId, video_id: vid, status: "queued", step: "", steps_json: "", error: "", created_at: new Date().toISOString(),
    }));
    try { await logTable.insert(logRows, { ignoreUnknownValues: true }); } catch {}

    // Return immediately — processing happens in background
    const response = NextResponse.json({
      ok: true,
      queued: videoIds.length,
      message: `Queued ${videoIds.length} videos for processing (${CONCURRENCY} concurrent)`,
    });

    // Fire-and-forget background processing
    processInBackground(runId, videoIds, speaker, transcriptCache, metadataCache);

    return response;
  } catch (error: any) {
    console.error("Research process error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process videos" },
      { status: 500 }
    );
  }
}

async function processInBackground(
  runId: string,
  videoIds: string[],
  speaker: string,
  transcriptCache: Map<string, any>,
  metadataCache: Map<string, any>
) {
  let idx = 0;
  let completed = 0;
  let failed = 0;

  async function worker() {
    while (idx < videoIds.length) {
      const videoId = videoIds[idx++];

      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const cached = transcriptCache.get(videoId);
      const meta = metadataCache.get(videoId);
      // Pipeline handles all BQ writes: streaming inserts for progress, single DML UPDATE at completion
      const result = await runPipeline(url, speaker, cached || undefined, meta, runId);

      if (result.success) completed++;
      else failed++;

      console.log(
        `[research/process] ${videoId}: ${result.success ? "complete" : "FAILED"} ${result.error || ""} (${completed + failed}/${videoIds.length})`
      );
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, videoIds.length) }, () => worker())
    );
    console.log(
      `[research/process] Done: ${completed} succeeded, ${failed} failed out of ${videoIds.length}`
    );
  } catch (err: any) {
    console.error("[research/process] Background processing error:", err.message);
  }
}
