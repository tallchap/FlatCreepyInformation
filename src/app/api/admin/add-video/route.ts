import { NextRequest, NextResponse } from "next/server";
import { addVideoYtOnly, checkVideo, extractId, type AddVideoEvent } from "@/lib/add-video";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// GET ?url= → what would be added (title, channel, length, suggested speaker,
// already-in-library, refusal reason).
export async function GET(req: NextRequest) {
  const id = extractId(req.nextUrl.searchParams.get("url") || "");
  if (!id) return NextResponse.json({ error: "Not a YouTube URL or video ID" }, { status: 400 });
  try {
    return NextResponse.json(await checkVideo(id));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST { videoId, speaker, mode: "yt-only" } → NDJSON stream of step events,
// ending in { step: "done" } or { step: "error" }.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = extractId(String(body.videoId || body.url || ""));
  const speaker = String(body.speaker || "").trim();
  if (!id) return NextResponse.json({ error: "Missing or invalid videoId" }, { status: 400 });
  if (!speaker) return NextResponse.json({ error: "Missing speaker" }, { status: 400 });
  if ((body.mode || "yt-only") !== "yt-only") return NextResponse.json({ error: 'Only mode "yt-only" is supported here' }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const t0 = Date.now();
      const emit = (e: AddVideoEvent) => controller.enqueue(enc.encode(JSON.stringify({ ...e, ms: Date.now() - t0 }) + "\n"));
      await addVideoYtOnly(id, speaker, emit);
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
