import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS } from "@/lib/bigquery-schema";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { runId, videoId, action, rejectReason, ruleGenerated } = body;

    if (!runId || !videoId || !action) {
      return NextResponse.json(
        { error: "Missing runId, videoId, or action" },
        { status: 400 }
      );
    }

    if (!["approved", "rejected", "skipped"].includes(action)) {
      return NextResponse.json(
        { error: "action must be approved, rejected, or skipped" },
        { status: 400 }
      );
    }

    await bigQuery.query({
      query: `
        UPDATE ${TABLE_REFS.researchCandidates}
        SET status = @status,
            reject_reason = @rejectReason,
            rule_generated = @ruleGenerated,
            vetted_at = CURRENT_TIMESTAMP()
        WHERE run_id = @runId AND video_id = @videoId
      `,
      params: {
        status: action,
        rejectReason: rejectReason || null,
        ruleGenerated: ruleGenerated || null,
        runId,
        videoId,
      },
    });

    return NextResponse.json({ ok: true, status: action });
  } catch (error: any) {
    console.error("Research vet error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update candidate" },
      { status: 500 }
    );
  }
}
