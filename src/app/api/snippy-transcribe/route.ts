import fs from "node:fs";
import { NextResponse } from "next/server";
import type { WordTimestamp } from "@/components/snippy/types";
import {
  extractAudioToMp3,
  safeUnlink,
} from "./audio";

export const maxDuration = 300;
export const runtime = "nodejs";

const ELEVENLABS_API_KEY_PRO = process.env.ELEVENLABS_API_KEY_PRO || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

interface CacheEntry {
  words: WordTimestamp[];
  createdAt: number;
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

async function transcribeViaElevenLabs(
  filePath: string,
  apiKey: string
): Promise<WordTimestamp[]> {
  const blob = new Blob([fs.readFileSync(filePath)], { type: "audio/mpeg" });
  const form = new FormData();
  form.append("file", blob, "audio.mp3");
  form.append("model_id", "scribe_v1");
  form.append("timestamps_granularity", "word");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs STT ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    words?: Array<{
      text: string;
      start?: number;
      end?: number;
      type?: string;
    }>;
  };
  return (data.words || [])
    .filter((w) => (w.type ?? "word") === "word")
    .filter((w) => typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({
      text: w.text,
      start: w.start as number,
      end: w.end as number,
    }));
}

async function transcribeViaOpenAI(filePath: string): Promise<WordTimestamp[]> {
  const MAX = 24 * 1024 * 1024;
  const size = fs.statSync(filePath).size;
  if (size > MAX) {
    throw new Error(
      `File ${(size / 1024 / 1024).toFixed(1)} MB exceeds OpenAI 24 MB budget`
    );
  }
  const blob = new Blob([fs.readFileSync(filePath)], { type: "audio/mpeg" });
  const form = new FormData();
  form.append("file", blob, "audio.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI Whisper ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    words?: Array<{ word: string; start: number; end: number }>;
  };
  return (data.words || []).map((w) => ({
    text: w.word,
    start: w.start,
    end: w.end,
  }));
}

async function transcribeFile(filePath: string): Promise<{
  words: WordTimestamp[];
  provider: string;
}> {
  const errors: string[] = [];

  if (ELEVENLABS_API_KEY_PRO) {
    try {
      const t0 = Date.now();
      const words = await transcribeViaElevenLabs(filePath, ELEVENLABS_API_KEY_PRO);
      console.log(
        `[snippy-transcribe] elevenlabs-pro: ${words.length} words in ${Date.now() - t0}ms`
      );
      return { words, provider: "elevenlabs-pro" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`elevenlabs-pro: ${msg}`);
      console.warn(`[snippy-transcribe] elevenlabs-pro failed: ${msg}`);
    }
  }

  if (ELEVENLABS_API_KEY) {
    try {
      const t0 = Date.now();
      const words = await transcribeViaElevenLabs(filePath, ELEVENLABS_API_KEY);
      console.log(
        `[snippy-transcribe] elevenlabs: ${words.length} words in ${Date.now() - t0}ms`
      );
      return { words, provider: "elevenlabs" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`elevenlabs: ${msg}`);
      console.warn(`[snippy-transcribe] elevenlabs failed: ${msg}`);
    }
  }

  if (OPENAI_API_KEY) {
    try {
      const t0 = Date.now();
      const words = await transcribeViaOpenAI(filePath);
      console.log(
        `[snippy-transcribe] openai: ${words.length} words in ${Date.now() - t0}ms`
      );
      return { words, provider: "openai" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`openai: ${msg}`);
      console.warn(`[snippy-transcribe] openai failed: ${msg}`);
    }
  }

  throw new Error(
    `All transcribers failed. ${errors.join(" | ") || "No transcriber configured."}`
  );
}

async function transcribeFullAudio(
  bunnyUrl: string,
  range?: { startSec: number; endSec: number }
): Promise<{ words: WordTimestamp[]; provider: string }> {
  const cacheKey = range
    ? `${bunnyUrl}|${range.startSec.toFixed(2)}-${range.endSec.toFixed(2)}`
    : bunnyUrl;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return { words: cached.words, provider: "cache" };
  }

  const audio = await extractAudioToMp3(
    bunnyUrl,
    range ? { startSec: range.startSec, endSec: range.endSec } : undefined
  );
  const tempFiles: string[] = audio.isCached ? [] : [audio.filePath];
  const offsetSec = range ? range.startSec : 0;

  try {
    const { words: rawWords, provider } = await transcribeFile(audio.filePath);
    const allWords: WordTimestamp[] = rawWords.map((w) => ({
      text: w.text,
      start: w.start + offsetSec,
      end: w.end + offsetSec,
    }));

    console.log(
      `[snippy-transcribe] total: ${allWords.length} words via ${provider}`
    );
    CACHE.set(cacheKey, { words: allWords, createdAt: Date.now() });
    return { words: allWords, provider };
  } finally {
    for (const f of tempFiles) safeUnlink(f);
  }
}

export async function POST(request: Request) {
  if (!ELEVENLABS_API_KEY_PRO && !ELEVENLABS_API_KEY && !OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "No transcriber API key configured" },
      { status: 500 }
    );
  }

  const body = (await request.json()) as {
    videoUrl?: string;
    startSec?: number;
    endSec?: number;
  };
  let { videoUrl, startSec, endSec } = body;

  if (!videoUrl) {
    return NextResponse.json({ error: "Missing videoUrl" }, { status: 400 });
  }

  // Extract actual Bunny CDN URL if client sent a proxy path like /api/bunny-proxy?src=...
  if (videoUrl.startsWith("/api/bunny-proxy")) {
    try {
      const proxyUrl = new URL(videoUrl, "https://placeholder.com");
      const realSrc = proxyUrl.searchParams.get("src");
      if (realSrc) videoUrl = realSrc;
    } catch {}
  }

  const range =
    startSec != null && endSec != null && endSec > startSec
      ? { startSec, endSec }
      : undefined;

  try {
    const { words, provider } = await transcribeFullAudio(videoUrl, range);
    return NextResponse.json({
      words,
      sourceWordCount: words.length,
      range: range || null,
      provider,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Transcribe failed";
    console.error("[snippy-transcribe]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
