import { NextRequest } from "next/server";
import { fetchTranscript } from "@/lib/bigquery";

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v") || "-mXVKLrgBwY";
  const search = req.nextUrl.searchParams.get("q") || "back off";

  const segments = await fetchTranscript(videoId);

  let matchIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].text.toLowerCase().includes(search.toLowerCase())) {
      matchIdx = i;
      break;
    }
  }

  const from = Math.max(0, (matchIdx >= 0 ? matchIdx : 0) - 5);
  const to = Math.min(segments.length - 1, (matchIdx >= 0 ? matchIdx : 0) + 5);
  const result = [];
  for (let i = from; i <= to; i++) {
    const s = segments[i].start ?? 0;
    const next = i + 1 < segments.length ? segments[i + 1].start ?? 0 : null;
    result.push({
      idx: i,
      start: s,
      end: next,
      time: `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`,
      text: segments[i].text,
      isMatch: i === matchIdx,
    });
  }

  const quote = "if we don't back off we die";
  const words = quote.toLowerCase().split(" ").filter((w) => w.length > 3);
  let best = 0, bestI = -1;
  for (let i = 0; i < segments.length; i++) {
    let win = "";
    for (let j = i; j < Math.min(i + 5, segments.length); j++) win += " " + segments[j].text;
    let score = 0;
    for (const w of words) if (win.toLowerCase().includes(w)) score++;
    if (score > best) { best = score; bestI = i; }
  }

  return Response.json({
    totalSegments: segments.length,
    searchTerm: search,
    matchSegment: matchIdx,
    segments: result,
    algorithm: {
      words,
      pickedSegmentIdx: bestI,
      pickedStart: bestI >= 0 ? segments[bestI].start : null,
      pickedText: bestI >= 0 ? segments[bestI].text : null,
      score: `${best}/${words.length}`,
    },
  });
}
