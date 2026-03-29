import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  // Search is triggered via CLI script (search.mjs) not the web API.
  // This route exists as a placeholder for future web-triggered search.
  // For now, return instructions.
  return NextResponse.json({
    message:
      "Use the CLI to run searches: node scripts/video-research/search.mjs '<speaker>' --after YYYY-MM-DD --before YYYY-MM-DD",
    hint: "Results will appear at /research?runId=<run_id>",
  });
}
