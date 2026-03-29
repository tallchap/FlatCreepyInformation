import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS } from "@/lib/bigquery-schema";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("runId");
  const status = req.nextUrl.searchParams.get("status");

  try {
    if (runId) {
      // Get candidates for a specific run
      let query = `SELECT * FROM ${TABLE_REFS.researchCandidates} WHERE run_id = @runId`;
      const params: Record<string, any> = { runId };
      if (status) {
        query += ` AND status = @status`;
        params.status = status;
      }
      query += ` ORDER BY confidence DESC`;

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
