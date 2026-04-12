import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS } from "@/lib/bigquery-schema";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("runId");
  const status = req.nextUrl.searchParams.get("status");

  try {
    if (runId) {
      // Simple query — base table + scores + rejections (no processing log join)
      let query = `
        SELECT c.run_id, c.video_id, c.title, c.channel, c.channel_id, c.duration_seconds,
          c.published_at, c.description, c.thumbnail_url, c.status, c.reject_reason,
          c.processing_status, c.processing_error, c.processing_step, c.processing_steps_json,
          c.matched_rules,
          s.confidence, s.reasoning, s.category, s.red_flags,
          r.rejection_type
        FROM ${TABLE_REFS.researchCandidates} c
        LEFT JOIN \`reptranscripts.research_candidate_scores\` s
          ON c.run_id = s.run_id AND c.video_id = s.video_id
        LEFT JOIN \`reptranscripts.research_candidate_rejections\` r
          ON c.run_id = r.run_id AND c.video_id = r.video_id
        WHERE c.run_id = @runId
      `;
      const params: Record<string, any> = { runId };
      if (status && status !== "all") {
        if (status === "pending") {
          query += ` AND c.status = 'pending' AND r.rejection_type IS NULL AND c.status NOT LIKE 'rejected%'`;
        } else if (status === "approved") {
          query += ` AND c.status = 'approved'`;
        } else if (status === "rejected") {
          query += ` AND (r.rejection_type IS NOT NULL OR c.status LIKE 'rejected%')`;
        } else if (status === "skipped") {
          query += ` AND c.status = 'skipped'`;
        }
      }
      query += ` ORDER BY s.confidence DESC NULLS LAST`;

      const [rows] = await bigQuery.query({ query, params });
      return NextResponse.json({ candidates: rows });
    }

    // List all runs
    const [runs] = await bigQuery.query({
      query: `SELECT * FROM ${TABLE_REFS.researchRuns} ORDER BY created_at DESC LIMIT 50`,
    });
    return NextResponse.json({ runs });
  } catch (error: any) {
    console.error("Research candidates error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch candidates" },
      { status: 500 }
    );
  }
}
