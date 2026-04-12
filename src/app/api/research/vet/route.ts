import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS } from "@/lib/bigquery-schema";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { runId, videoId, videoIds, action, rejectReason, ruleGenerated } = body;

    if (!runId || !action) {
      return NextResponse.json({ error: "Missing runId or action" }, { status: 400 });
    }
    if (!["approved", "rejected", "skipped"].includes(action)) {
      return NextResponse.json({ error: "action must be approved, rejected, or skipped" }, { status: 400 });
    }

    // Batch mode: array of videoIds
    const ids = videoIds || (videoId ? [videoId] : []);
    if (ids.length === 0) {
      return NextResponse.json({ error: "Missing videoId or videoIds" }, { status: 400 });
    }

    await bigQuery.query({
      query: `
        UPDATE ${TABLE_REFS.researchCandidates}
        SET status = @status,
            reject_reason = @rejectReason,
            rule_generated = @ruleGenerated,
            vetted_at = CURRENT_TIMESTAMP()
        WHERE run_id = @runId AND video_id IN UNNEST(@ids)
      `,
      params: {
        status: action,
        rejectReason: rejectReason || "",
        ruleGenerated: ruleGenerated || "",
        runId,
        ids,
      },
    });

    return NextResponse.json({ ok: true, status: action, count: ids.length });
  } catch (error: any) {
    console.error("Research vet error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update candidate" },
      { status: 500 }
    );
  }
}
