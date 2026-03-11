import { NextRequest } from "next/server";
import { fetchSpeakerVideos, fetchTranscript } from "@/lib/bigquery";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const speaker = req.nextUrl.searchParams.get("speaker");
  if (!speaker) {
    return new Response("Missing speaker param", { status: 400 });
  }

  // Fetch all videos for this speaker (up to 500)
  const { videos } = await fetchSpeakerVideos(speaker, 1, 500);

  if (!videos.length) {
    return new Response("No videos found for this speaker", { status: 404 });
  }

  // Fetch transcripts in parallel
  const entries = await Promise.all(
    videos.map(async (v: any) => {
      const segments = await fetchTranscript(v.id);
      const text = segments.map((s: any) => s.text).join(" ");
      const date = v.published
        ? new Date(v.published).toISOString().slice(0, 10)
        : "Unknown date";
      return { title: v.title, channel: v.channel, date, text };
    }),
  );

  // Build plain text document
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`Title: ${entry.title}`);
    lines.push(`Channel: ${entry.channel}`);
    lines.push(`Date: ${entry.date}`);
    lines.push("");
    lines.push(entry.text);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const body = lines.join("\n");
  const filename = `${speaker.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "_")}_transcripts.txt`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
