// src/app/api/chat/route.ts
// ─────────────────────────────────────────────────────────────
//  Chat API — OpenAI Responses API with file_search + metadata filters
//  Migrated from Assistants API (threads/runs)
// ─────────────────────────────────────────────────────────────
import { NextRequest } from "next/server";
import OpenAI from "openai";
import { getSpeakerBySlug } from "@/lib/speakers";
import { fetchTranscript, fetchVideoMeta } from "@/lib/bigquery";
import citationMap from "@/lib/file-citation-map.json";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.CHAT_MODEL || "gpt-5.4";

// ── Citation helpers ────────────────────────────────────────────────────

type CitationMetadata = {
  publishedAt?: string;
  channel?: string;
  speakers?: string[];
  durationSec?: number;
  viewCount?: number | null;
};

// Flat lookup: file_id → { videoId, title } from the legacy citation map.
// This is still used as a fallback — file attributes are the primary source.
type CitationEntry = { videoId: string; title: string };
const FILE_ID_LOOKUP: Record<string, CitationEntry> = {};
for (const speaker of Object.values(citationMap)) {
  const files = (speaker as { files: Record<string, CitationEntry> }).files;
  for (const [fileId, meta] of Object.entries(files)) {
    FILE_ID_LOOKUP[fileId] = meta;
  }
}

function parseDurationToSeconds(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(":")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return undefined;
}

function splitSpeakers(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  const speakers = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return speakers.length > 0 ? speakers : undefined;
}

// ── Metadata filter construction ────────────────────────────────────────

type ComparisonFilter = {
  type: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
  key: string;
  value: string | number | boolean;
};

type CompoundFilter = {
  type: "and" | "or";
  filters: (ComparisonFilter | CompoundFilter)[];
};

type FileSearchFilter = ComparisonFilter | CompoundFilter;

function detectBeforeYear(message: string): number | null {
  const lower = message.toLowerCase();
  const match = lower.match(/\bbefore\s+(\d{4})\b/);
  return match ? parseInt(match[1], 10) : null;
}

function detectAfterYear(message: string): number | null {
  const lower = message.toLowerCase();
  const match = lower.match(/\bafter\s+(\d{4})\b/);
  return match ? parseInt(match[1], 10) : null;
}

function buildFilters(speakerName: string, message: string): FileSearchFilter | undefined {
  const conditions: ComparisonFilter[] = [];

  const beforeYear = detectBeforeYear(message);
  if (beforeYear) {
    conditions.push({ type: "lt", key: "published_year", value: beforeYear });
  }

  const afterYear = detectAfterYear(message);
  if (afterYear) {
    conditions.push({ type: "gt", key: "published_year", value: afterYear });
  }

  // No date constraints detected — return undefined (unfiltered search)
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { type: "and", filters: conditions };
}

// ── Timestamp matching ──────────────────────────────────────────────────

function findTimestampForQuote(
  quote: string,
  segments: { start: number | null; text: string }[],
): number | null {
  if (!quote || segments.length === 0) return null;

  const normalizedQuote = quote.toLowerCase().replace(/\s+/g, " ").trim();
  const quoteWords = normalizedQuote.split(" ").filter((w) => w.length > 3);
  if (quoteWords.length === 0) return null;

  let bestScore = 0;
  let bestTimestamp: number | null = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.start === null) continue;

    let windowText = "";
    for (let j = i; j < Math.min(i + 5, segments.length); j++) {
      windowText += " " + segments[j].text;
    }
    const normalizedWindow = windowText.toLowerCase().replace(/\s+/g, " ");

    let score = 0;
    for (const word of quoteWords) {
      if (normalizedWindow.includes(word)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestTimestamp = seg.start;
    }
  }

  return bestScore >= quoteWords.length * 0.3 ? bestTimestamp : null;
}

// ── System prompt ───────────────────────────────────────────────────────

function buildSystemPrompt(speakerName: string): string {
  return [
    `You are a research assistant with access to video transcript data from ${speakerName}.`,
    `When answering questions, always cite the specific video sources using the file annotations provided by file_search.`,
    `If a question cannot be answered from the available transcripts, say so clearly.`,
    `Be concise and accurate. Quote directly from transcripts when relevant.`,
  ].join("\n");
}

// ── API Route ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { speaker, message, messages: clientMessages } = body as {
      speaker: string;
      message: string;
      messages?: { role: "user" | "assistant"; content: string }[];
    };

    if (!speaker || !message) {
      return Response.json(
        { error: "speaker and message are required" },
        { status: 400 },
      );
    }

    const speakerConfig = getSpeakerBySlug(speaker);
    if (!speakerConfig) {
      return Response.json({ error: "Unknown speaker" }, { status: 400 });
    }

    // Build conversation input
    const input: OpenAI.Responses.ResponseInput = [];

    // System prompt
    input.push({
      role: "developer",
      content: buildSystemPrompt(speakerConfig.name),
    });

    // Previous messages (conversation history from client)
    if (clientMessages && clientMessages.length > 0) {
      // Include all messages except the last user message (which is the current one)
      for (const msg of clientMessages.slice(0, -1)) {
        input.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content,
        });
      }
    }

    // Current user message
    input.push({ role: "user", content: message });

    // Build metadata filters
    const filters = buildFilters(speakerConfig.name, message);

    // Call Responses API with file_search
    const stream = await openai.responses.create({
      model: MODEL,
      input,
      tools: [
        {
          type: "file_search" as const,
          vector_store_ids: [speakerConfig.vectorStoreId],
          max_num_results: 20,
          ...(filters ? { filters } : {}),
        },
      ],
      stream: true,
    });

    // Stream SSE to client
    const encoder = new TextEncoder();
    let fullResponseText = "";
    let responseId = "";

    // Collected annotations from streaming events
    const collectedAnnotations: any[] = [];
    const collectedBlockTexts: string[] = [];
    const eventTypes: string[] = [];

    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            eventTypes.push(event.type);

            // Capture response ID
            if (event.type === "response.created") {
              responseId = event.response.id;
            }

            // Stream text deltas
            if (
              event.type === "response.output_text.delta" &&
              event.delta
            ) {
              fullResponseText += event.delta;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "text_delta", text: event.delta })}\n\n`,
                ),
              );
            }

            // Capture annotations when a text block is complete
            if (event.type === "response.output_text.done") {
              const evt = event as any;
              if (evt.annotations && evt.annotations.length > 0) {
                collectedAnnotations.push(...evt.annotations);
              }
              if (evt.text) {
                collectedBlockTexts.push(evt.text);
              }
            }

            // Also try content_part.done
            if (event.type === "response.content_part.done") {
              const part = (event as any).part;
              if (part?.annotations && part.annotations.length > 0) {
                collectedAnnotations.push(...part.annotations);
              }
              if (part?.text) {
                collectedBlockTexts.push(part.text);
              }
            }

            // Response complete — resolve citations
            if (event.type === "response.completed") {
              try {
                await resolveCitations(
                  event.response,
                  fullResponseText,
                  collectedAnnotations,
                  controller,
                  encoder,
                  eventTypes,
                );
              } catch (err) {
                console.error("Error resolving citations:", err);
                // Send error as visible debug
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "text_delta", text: `\n\n[Debug: citation error: ${err}]` })}\n\n`,
                  ),
                );
              }
            }
          }
        } catch (error) {
          console.error("Stream error:", error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", error: "An error occurred while processing your request." })}\n\n`,
            ),
          );
        }

        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "done" })}\n\n`,
            ),
          );
          controller.close();
        } catch {
          /* stream already closed */
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// ── Citation resolution ─────────────────────────────────────────────────

interface AnnotationInfo {
  startIndex: number;
  endIndex: number;
  fileId: string;
  videoId: string;
  title: string;
}

async function resolveCitations(
  response: any,
  fullText: string,
  streamAnnotations: any[],
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  eventTypes: string[],
) {
  // Step 1: Collect file_citation annotations
  // Use streaming annotations first, fallback to response.output
  const rawAnns = streamAnnotations.length > 0
    ? streamAnnotations
    : extractResponseAnnotations(response);

  const annotations: AnnotationInfo[] = [];

  for (const ann of rawAnns) {
    if (ann.type !== "file_citation") continue;
    if (typeof ann.index !== "number") continue;

    // Extract video ID from filename (e.g. "transcript_-mXVKLrgBwY.txt" → "-mXVKLrgBwY")
    let videoId: string | undefined;
    let title: string | undefined;

    if (ann.filename) {
      const match = ann.filename.match(/^transcript_(.+)\.txt$/);
      if (match) videoId = match[1];
    }

    // Try file attributes
    if (ann.file_id) {
      const searchResult = findFileSearchResults(response, ann.file_id);
      if (searchResult?.attributes) {
        if (!videoId) videoId = searchResult.attributes.video_id as string;
        title = searchResult.attributes.title as string;
      }
    }

    // Fallback to legacy citation map
    if (!videoId && ann.file_id) {
      const entry = FILE_ID_LOOKUP[ann.file_id];
      if (entry) { videoId = entry.videoId; title = entry.title; }
    }

    if (!videoId) continue;

    // Look up title from citation map if we only got it from filename
    if (!title && ann.file_id) {
      const entry = FILE_ID_LOOKUP[ann.file_id];
      if (entry) title = entry.title;
    }

    annotations.push({
      startIndex: ann.index,
      endIndex: ann.index, // single position — link is inserted here
      fileId: ann.file_id || "",
      videoId,
      title: title || "",
    });
  }

  // Debug removed — citations confirmed working

  if (annotations.length === 0) return;

  // Step 2: Fetch transcripts to find timestamps
  const uniqueVideoIds = [...new Set(annotations.map((a) => a.videoId))];
  const transcriptCache: Record<string, { start: number | null; text: string }[]> = {};
  const metadataCache: Record<string, CitationMetadata> = {};

  await Promise.all(
    uniqueVideoIds.map(async (videoId) => {
      try {
        transcriptCache[videoId] = await fetchTranscript(videoId);
      } catch {
        transcriptCache[videoId] = [];
      }
      try {
        const meta = await fetchVideoMeta(videoId);
        if (meta) {
          let publishedStr: string | undefined;
          try {
            const pub = meta.published;
            if (pub) {
              if (typeof pub === "string") {
                publishedStr = pub;
              } else if (pub instanceof Date) {
                publishedStr = pub.toISOString().slice(0, 10);
              } else if (typeof pub === "object" && pub.value) {
                publishedStr = String(pub.value);
              } else {
                publishedStr = String(pub);
              }
            }
          } catch { /* ignore */ }

          metadataCache[videoId] = {
            publishedAt: publishedStr,
            channel: meta.channel || undefined,
            speakers: splitSpeakers(meta.speakers),
            durationSec: parseDurationToSeconds(meta.video_length),
            viewCount: null,
          };
        }
      } catch (err) {
        console.error(`fetchVideoMeta failed for ${videoId}:`, err);
      }
    }),
  );

  // Step 3: Rebuild text with citation links injected at annotation positions
  // Sort by startIndex descending so replacements don't shift earlier positions
  const sorted = [...annotations].sort((a, b) => b.startIndex - a.startIndex);

  let rewrittenText = fullText;

  for (const ann of sorted) {
    // Smart quote extraction: find the quoted text nearest the citation position
    // Look backward from the annotation index for the closing quote, then the opening quote
    const textWindow = fullText.substring(Math.max(0, ann.startIndex - 500), ann.startIndex);
    let quotedText = "";

    // Try to find text between quote marks (supports "" and "")
    const quoteChars = ['"', '\u201c', '\u201d'];
    // Find the last closing quote in the window (nearest to citation)
    let closeIdx = -1;
    for (let i = textWindow.length - 1; i >= 0; i--) {
      if (quoteChars.includes(textWindow[i])) {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx > 0) {
      // Find the opening quote before the closing quote
      let openIdx = -1;
      for (let i = closeIdx - 1; i >= 0; i--) {
        if (quoteChars.includes(textWindow[i])) {
          openIdx = i;
          break;
        }
      }
      if (openIdx >= 0 && openIdx < closeIdx) {
        quotedText = textWindow.substring(openIdx + 1, closeIdx);
      }
    }

    // Fallback: use the last 300 characters if no quotes found
    if (!quotedText) {
      quotedText = textWindow.slice(-300);
    }

    const segments = transcriptCache[ann.videoId] || [];
    const timestamp = findTimestampForQuote(quotedText, segments);

    const ytRef = timestamp !== null
      ? `youtube:${ann.videoId}:${Math.floor(timestamp)}`
      : `youtube:${ann.videoId}`;

    // Prefer file_search attributes, fall back to BigQuery metadata
    const attrs = findFileSearchResults(response, ann.fileId)?.attributes;
    const meta = metadataCache[ann.videoId];

    const title = (attrs?.title as string) || ann.title || meta?.channel || "";
    const channel = (attrs?.channel as string) || meta?.channel || "";
    const rawDate = (attrs?.published_date as string) || meta?.publishedAt || "";

    // Format date as MM/DD/YYYY
    let formattedDate = "";
    if (rawDate) {
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) {
        formattedDate = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
      }
    }

    const metaParts = [channel, formattedDate].filter(Boolean);
    const label = metaParts.length > 0
      ? `${title} (${metaParts.join(" | ")})`
      : title;

    const link = ` [${label}](${ytRef})`;

    rewrittenText =
      rewrittenText.substring(0, ann.startIndex) +
      link +
      rewrittenText.substring(ann.endIndex);
  }

  // Step 4: Send rewrite event — client replaces the entire message content
  controller.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({ type: "rewrite", content: rewrittenText })}\n\n`,
    ),
  );
}

function extractResponseAnnotations(response: any): any[] {
  const result: any[] = [];
  for (const outputItem of response.output || []) {
    if (outputItem.type !== "message") continue;
    for (const block of outputItem.content || []) {
      if (block.type !== "output_text") continue;
      result.push(...(block.annotations || []));
    }
  }
  return result;
}

function findFileSearchResults(
  response: any,
  fileId: string,
): { attributes?: Record<string, unknown> } | undefined {
  for (const outputItem of response.output || []) {
    if (outputItem.type === "file_search_call") {
      for (const result of outputItem.results || []) {
        if (result.file_id === fileId) {
          return { attributes: result.attributes };
        }
      }
    }
  }
  return undefined;
}
