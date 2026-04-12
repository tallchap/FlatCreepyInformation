import OpenAI from "openai";
import * as fs from "fs";

const SHARED_VECTOR_STORE_ID = "vs_69b1015315d88191b6f26c169575bc4c";

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function slugify(name: string): string {
  return stripDiacritics(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseDurationToSec(raw: string | number | null | undefined): number | null {
  if (!raw) return null;
  if (typeof raw === "number") return raw;
  const parts = raw.split(":").map((p) => Number(p.trim())).filter((n) => Number.isFinite(n));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

interface VectorUploadParams {
  videoId: string;
  title: string;
  channel: string;
  publishedDate: string | null;
  duration: string | null;
  speakerSource: string; // comma-separated speaker names
  languageCode: string;
  segments: TranscriptSegment[];
}

export async function uploadToVectorStore(params: VectorUploadParams): Promise<void> {
  const { videoId, title, channel, publishedDate, duration, speakerSource, languageCode, segments } = params;

  if (!process.env.OPENAI_API_KEY) {
    console.error("Vector upload skipped: OPENAI_API_KEY not set");
    return;
  }

  if (segments.length === 0) {
    console.log("Vector upload skipped: no transcript segments");
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Format transcript with timestamps
  const transcriptText = segments
    .map((seg) => {
      const m = Math.floor(seg.start / 60);
      const s = Math.floor(seg.start % 60);
      return `[${m}:${String(s).padStart(2, "0")}] ${seg.text}`;
    })
    .join("\n");

  if (transcriptText.length < 100) {
    console.log("Vector upload skipped: transcript too short");
    return;
  }

  const allSpeakers = speakerSource.split(",").map((s) => s.trim()).filter(Boolean);
  const durationSec = parseDurationToSec(duration);
  const publishedYear = publishedDate ? Number(publishedDate.split("-")[0]) || null : null;
  const dateStr = publishedDate || "Unknown";

  for (const speaker of allSpeakers) {
    const speakerSlug = slugify(speaker);
    const others = allSpeakers
      .filter((s) => s !== speaker)
      .map(stripDiacritics)
      .sort();

    // 1. Upload file to OpenAI
    const content = `VIDEO_ID: ${videoId}
Title: ${title}
Date: ${dateStr}
URL: https://youtu.be/${videoId}
${"─".repeat(37)}
${transcriptText}
${"─".repeat(37)}
END OF TRANSCRIPT — Video ID: ${videoId} — Title: ${title}`;

    const tmpPath = `/tmp/transcript_${videoId}_${speakerSlug}.txt`;
    fs.writeFileSync(tmpPath, content);

    const file = await openai.files.create({
      file: fs.createReadStream(tmpPath),
      purpose: "assistants",
    });

    fs.unlinkSync(tmpPath);

    // 2. Add file to shared vector store
    await openai.vectorStores.fileBatches.createAndPoll(SHARED_VECTOR_STORE_ID, {
      file_ids: [file.id],
    });

    // 3. Set metadata attributes
    const attributes: Record<string, string | number> = {
      video_id: videoId,
      speaker: stripDiacritics(speaker),
      title: title.slice(0, 512),
      channel: (channel || "").slice(0, 512),
      language: languageCode || "en",
    };

    if (publishedDate) attributes.published_date = publishedDate;
    if (publishedYear) attributes.published_year = publishedYear;
    if (durationSec) attributes.duration_sec = durationSec;

    for (let j = 0; j < Math.min(others.length, 3); j++) {
      attributes[`co_speaker_${j + 1}`] = others[j].slice(0, 512);
    }

    await openai.vectorStores.files.update(SHARED_VECTOR_STORE_ID, file.id, { attributes });

    console.log(`Vector store: uploaded ${speaker} | ${videoId} | ${title.slice(0, 50)}`);
  }
}
