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
const MODEL = process.env.CHAT_MODEL || "gpt-4.1";

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

    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
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

            // Response complete — resolve citations
            if (event.type === "response.completed") {
              try {
                await resolveCitations(
                  event.response,
                  fullResponseText,
                  controller,
                  encoder,
                );
              } catch (err) {
                console.error("Error resolving citations:", err);
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

async function resolveCitations(
  response: any,
  fullText: string,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
) {
  const citations: Record<
    string,
    {
      videoId: string;
      title: string;
      timestamp?: number;
      metadata?: CitationMetadata;
    }
  > = {};

  // Collect annotations from the response output
  const pendingCitations: {
    marker: string;
    videoId: string;
    title: string;
    quotedText: string;
  }[] = [];

  for (const outputItem of response.output || []) {
    if (outputItem.type !== "message") continue;

    for (const block of outputItem.content || []) {
      if (block.type !== "output_text") continue;

      for (const ann of block.annotations || []) {
        if (ann.type !== "file_citation") continue;

        const fileId = ann.file_id;
        if (!fileId) continue;

        // Try to get video info from file attributes (preferred) or fallback to citation map
        let videoId: string | undefined;
        let title: string | undefined;

        // Check file attributes first (set during migration)
        // Attributes come from the file_search results in the response
        const fileSearchResults = findFileSearchResults(response, fileId);
        if (fileSearchResults?.attributes) {
          videoId = fileSearchResults.attributes.video_id as string;
          title = fileSearchResults.attributes.title as string;
        }

        // Fallback to legacy citation map
        if (!videoId) {
          const entry = FILE_ID_LOOKUP[fileId];
          if (entry) {
            videoId = entry.videoId;
            title = entry.title;
          }
        }

        if (!videoId) continue;

        // Extract text before annotation for timestamp matching
        const annText = ann.text || "";
        const textBefore = fullText
          .substring(
            Math.max(0, fullText.indexOf(annText) - 200),
            fullText.indexOf(annText),
          )
          .trim();

        pendingCitations.push({
          marker: annText,
          videoId,
          title: title || "",
          quotedText: textBefore,
        });
      }
    }
  }

  if (pendingCitations.length === 0) return;

  // Fetch transcripts for unique video IDs and resolve timestamps
  const uniqueVideoIds = [...new Set(pendingCitations.map((c) => c.videoId))];
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
          metadataCache[videoId] = {
            publishedAt:
              typeof meta.published === "string"
                ? meta.published
                : meta.published.toISOString().slice(0, 10),
            channel: meta.channel || undefined,
            speakers: splitSpeakers(meta.speakers),
            durationSec: parseDurationToSeconds(meta.video_length),
            viewCount: null,
          };
        }
      } catch {
        // leave empty
      }
    }),
  );

  // Build citations with timestamps
  for (const pc of pendingCitations) {
    const segments = transcriptCache[pc.videoId] || [];
    const timestamp = findTimestampForQuote(pc.quotedText, segments);

    citations[pc.marker] = {
      videoId: pc.videoId,
      title: pc.title,
      ...(timestamp !== null && { timestamp: Math.floor(timestamp) }),
      ...(metadataCache[pc.videoId] && { metadata: metadataCache[pc.videoId] }),
    };
  }

  if (Object.keys(citations).length > 0) {
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: "citations", citations })}\n\n`,
      ),
    );
  }
}

// Helper to find file_search results for a given file ID in the response
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
