import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { CLIP_RULES } from "@/lib/clip-rules";

let openai: OpenAI | null = null;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

type TranscriptLine = { start: number; text: string };

export async function POST(req: NextRequest) {
  try {
    const { transcript, query, promptType, previousSnippets } = (await req.json()) as {
      transcript: TranscriptLine[];
      query: string;
      promptType: "bestSnippets" | "aiSafety" | "general";
      previousSnippets?: { startSec: number; endSec: number; description: string }[];
    };

    if (!transcript || transcript.length === 0) {
      return NextResponse.json({ error: "No transcript provided" }, { status: 400 });
    }

    const promptRules = CLIP_RULES[promptType] || CLIP_RULES.general;

    const transcriptText = transcript
      .map((l) => `[${formatTime(l.start)}] ${l.text}`)
      .join("\n");

    const systemPrompt = `${promptRules}\n\n${CLIP_RULES.shared}`;

    let excludeBlock = "";
    if (previousSnippets && previousSnippets.length > 0) {
      const ranges = previousSnippets
        .map((s) => `${formatTime(s.startSec)}–${formatTime(s.endSec)}: ${s.description}`)
        .join("\n");
      excludeBlock = `\n\nALREADY SUGGESTED (do NOT repeat or overlap these):\n${ranges}`;
    }

    const userMessage = query
      ? `${query}${excludeBlock}\n\nTRANSCRIPT:\n${transcriptText}`
      : `${excludeBlock}\n\nTRANSCRIPT:\n${transcriptText}`;

    const client = getOpenAI();
    const response = await client.chat.completions.create({
      model: "gpt-5.4-2026-03-05",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ snippets: [] });
    }

    const parsed = JSON.parse(content);
    const snippets = Array.isArray(parsed.snippets) ? parsed.snippets : [];

    return NextResponse.json({ snippets });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("clip-finder error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
