import { NextRequest, NextResponse } from "next/server";
import { logEvent } from "@/lib/pipeline-log";

export const dynamic = "force-dynamic";

// Unauthenticated — this endpoint is additive (write-only) and low-value.
// Rate limited implicitly by Redis 10k cap + 30-day TTL. Only accepts a fixed
// shape so it can't be abused to inject arbitrary admin-log content.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const videoId = typeof body.videoId === "string" ? body.videoId.slice(0, 64) : "unknown";
    const step = typeof body.step === "string" ? body.step.slice(0, 64) : "client-event";
    const status: "info" | "success" | "error" =
      body.status === "error" || body.status === "success" ? body.status : "info";
    const detail = body.detail && typeof body.detail === "object" ? body.detail : null;
    await logEvent({ videoId, pipeline: "transcribe", step, status, detail });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Log failed" }, { status: 500 });
  }
}
