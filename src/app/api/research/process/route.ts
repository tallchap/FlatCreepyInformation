import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS } from "@/lib/bigquery-schema";
import { runPipeline } from "@/lib/research-pipeline";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300; // 5 minutes for long pipeline runs

export async function POST(req: NextRequest) {
  try {
    const { runId, videoIds, speaker } = await req.json();

    if (!runId || !videoIds?.length || !speaker) {
      return NextResponse.json(
        { error: "Missing runId, videoIds, or speaker" },
        { status: 400 }
      );
    }

    // Mark all as queued
    for (const videoId of videoIds) {
      await bigQuery.query({
        query: `
          UPDATE ${TABLE_REFS.researchCandidates}
          SET processing_status = 'queued'
          WHERE run_id = @runId AND video_id = @videoId
        `,
        params: { runId, videoId },
      });
    }

    // Process sequentially
    const results: Array<{
      videoId: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const videoId of videoIds) {
      // Mark as processing
      await bigQuery.query({
        query: `
          UPDATE ${TABLE_REFS.researchCandidates}
          SET processing_status = 'processing'
          WHERE run_id = @runId AND video_id = @videoId
        `,
        params: { runId, videoId },
      });

      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const result = await runPipeline(url, speaker);

      // Update status
      await bigQuery.query({
        query: `
          UPDATE ${TABLE_REFS.researchCandidates}
          SET processing_status = @procStatus,
              processing_error = @procError,
              processed_at = CURRENT_TIMESTAMP()
          WHERE run_id = @runId AND video_id = @videoId
        `,
        params: {
          procStatus: result.success ? "complete" : "failed",
          procError: result.error || null,
          runId,
          videoId,
        },
      });

      results.push({
        videoId,
        success: result.success,
        error: result.error,
      });

      console.log(
        `[research/process] ${videoId}: ${result.success ? "complete" : "FAILED"} ${result.error || ""}`
      );
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return NextResponse.json({
      ok: true,
      processed: results.length,
      succeeded,
      failed,
      results,
    });
  } catch (error: any) {
    console.error("Research process error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process videos" },
      { status: 500 }
    );
  }
}
