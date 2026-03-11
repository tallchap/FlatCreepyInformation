// src/app/api/chat/route.ts
// ─────────────────────────────────────────────────────────────
//  Chat API — OpenAI Responses API with file_search + metadata filters
//  Migrated from Assistants API (threads/runs)
// ─────────────────────────────────────────────────────────────
import { NextRequest } from "next/server";
import OpenAI from "openai";
import { resolveSpeaker, stripDiacritics, slugify } from "@/lib/speakers";
import { fetchTranscript, fetchVideoMeta, fetchSpeakerFilterContext } from "@/lib/bigquery";
import citationMap from "@/lib/file-citation-map.json";

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}
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

// ── GPT pre-pass filter detection ─────────────────────────────────────

interface DetectedFilters {
  channel: string | null;
  coSpeaker: string | null;
  excludeChannel: string | null;
  excludeCoSpeaker: string | null;
  yearBefore: number | null;
  yearAfter: number | null;
}

interface DetectFiltersResult {
  filters: DetectedFilters;
  debugSystemPrompt: string;
  debugUserMessage: string;
}

async function detectFilters(
  message: string,
  speakerName: string,
): Promise<DetectFiltersResult> {
  const defaults: DetectedFilters = { channel: null, coSpeaker: null, excludeChannel: null, excludeCoSpeaker: null, yearBefore: null, yearAfter: null };

  try {
    const ctx = await fetchSpeakerFilterContext(speakerName);

    const systemPrompt = `You are a metadata filter extractor. Your job is to detect mentions of year, channel, or co-speaker in the user's message — even if misspelled — and output a JSON object.

The user is searching transcripts from ${speakerName}. Below are the valid filter values:

Channels: ${ctx.channels.map(c => `"${c}"`).join(", ")}
Co-speakers (other people who appeared with ${speakerName}): ${ctx.coSpeakers.map(s => `"${s}"`).join(", ")}
Years: 2000 through 2026

Rules:
- Only extract a filter if the user's message clearly references it
- Match co-speaker names even if misspelled (e.g. "Lex" → "Lex Fridman")
- If the user says "non", "not", "except", "excluding", "without", or "no" before a name, that is EXCLUSION — use excludeChannel / excludeCoSpeaker, NOT the include fields
- "non" before a person's name is negation (exclusion), NOT a match for the channel "Nonzero"
- yearBefore means "published before this year" (exclusive)
- yearAfter means "published after this year" (exclusive)
- If nothing is mentioned, set the field to null

I will start the JSON and you will complete it:
{
  "userMessage": "${message.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}",
  "channel":`;

    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Complete the JSON above." },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const raw = response.choices[0].message.content || "{}";
    // 4o-mini may return just the completion or a full JSON — handle both
    const jsonStr = raw.trimStart().startsWith("{") ? raw : `{"userMessage":"","channel":${raw}`;
    const parsed = JSON.parse(jsonStr);
    return {
      filters: {
        channel: parsed.channel || null,
        coSpeaker: parsed.coSpeaker || null,
        excludeChannel: parsed.excludeChannel || null,
        excludeCoSpeaker: parsed.excludeCoSpeaker || null,
        yearBefore: parsed.yearBefore ? Number(parsed.yearBefore) : null,
        yearAfter: parsed.yearAfter ? Number(parsed.yearAfter) : null,
      },
      debugSystemPrompt: systemPrompt,
      debugUserMessage: message,
    };
  } catch (err) {
    console.error("Filter detection failed, proceeding unfiltered:", err);
    return { filters: defaults, debugSystemPrompt: "(failed)", debugUserMessage: message };
  }
}

function buildFiltersFromDetected(detected: DetectedFilters, isSharedStore = false): FileSearchFilter | undefined {
  const conditions: (ComparisonFilter | CompoundFilter)[] = [];

  if (detected.yearBefore) {
    conditions.push({ type: "lt", key: "published_year", value: detected.yearBefore });
  }
  if (detected.yearAfter) {
    conditions.push({ type: "gt", key: "published_year", value: detected.yearAfter });
  }
  if (detected.channel) {
    conditions.push({ type: "eq", key: "channel", value: detected.channel });
  }
  if (detected.excludeChannel) {
    conditions.push({ type: "ne", key: "channel", value: detected.excludeChannel });
  }

  // Co-speaker filtering: shared store uses co_speaker_1..3, legacy uses speaker_1..5
  if (detected.coSpeaker) {
    if (isSharedStore) {
      conditions.push({
        type: "or",
        filters: [1, 2, 3].map(i => ({
          type: "eq" as const,
          key: `co_speaker_${i}`,
          value: detected.coSpeaker!,
        })),
      });
    } else {
      conditions.push({
        type: "or",
        filters: [1, 2, 3, 4, 5].map(i => ({
          type: "eq" as const,
          key: `speaker_${i}`,
          value: detected.coSpeaker!,
        })),
      });
    }
  }
  if (detected.excludeCoSpeaker) {
    if (isSharedStore) {
      conditions.push({
        type: "and",
        filters: [1, 2, 3].map(i => ({
          type: "ne" as const,
          key: `co_speaker_${i}`,
          value: detected.excludeCoSpeaker!,
        })),
      });
    } else {
      conditions.push({
        type: "and",
        filters: [1, 2, 3, 4, 5].map(i => ({
          type: "ne" as const,
          key: `speaker_${i}`,
          value: detected.excludeCoSpeaker!,
        })),
      });
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { type: "and", filters: conditions };
}

// ── Timestamp matching ──────────────────────────────────────────────────

function findTimestampForQuote(
  quote: string,
  segments: { start: number | null; text: string }[],
): { timestamp: number | null; method: string } {
  if (!quote || segments.length === 0) return { timestamp: null, method: "none" };

  const normalizedQuote = quote.toLowerCase().replace(/\s+/g, " ").trim();
  const quoteWords = normalizedQuote.split(" ").filter((w) => w.length > 3);
  if (quoteWords.length === 0) return { timestamp: null, method: "none" };

  let bestScore = 0;
  let bestTimestamp: number | null = null;
  let bestIdx = 0;

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
      bestIdx = i;
    }
  }

  if (bestScore < quoteWords.length * 0.3) return { timestamp: null, method: "none" };

  // Refinement: cascade 3→2→1 word exact match within winning 5-segment window
  const allWords = normalizedQuote.split(" ");
  const winnerSegs = segments.slice(bestIdx, bestIdx + 5);

  for (let n = 3; n >= 1; n--) {
    if (allWords.length < n) continue;
    const phrase = allWords.slice(0, n).join(" ");
    for (const seg of winnerSegs) {
      if (seg.start !== null && seg.text.toLowerCase().includes(phrase)) {
        return { timestamp: seg.start, method: `quote-${n}` };
      }
    }
  }

  return { timestamp: bestTimestamp, method: "quote-segment" };
}

// ── System prompt ───────────────────────────────────────────────────────

function buildSystemPrompt(speakerName: string): string {
  return [
    `You are a research assistant with access to video transcript data from ${speakerName}.`,
    `When answering questions, always cite the specific video sources using the file annotations provided by file_search.`,
    `If a question cannot be answered from the available transcripts, say so clearly.`,
    `Be concise and accurate. Quote directly from transcripts when relevant.`,
    `NEVER comment on transcript quality, spelling variations, transcription artifacts, or how names are rendered in transcripts.`,
  ].join("\n");
}

// ── API Route ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { speaker, speakerName: rawSpeakerName, message, messages: clientMessages } = body as {
      speaker: string;
      speakerName?: string;
      message: string;
      messages?: { role: "user" | "assistant"; content: string }[];
    };

    if (!speaker || !message) {
      return Response.json(
        { error: "speaker and message are required" },
        { status: 400 },
      );
    }

    const speakerConfig = resolveSpeaker(speaker, rawSpeakerName);
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

    // GPT pre-pass: detect filters from natural language (~200-400ms)
    const detectResult = await detectFilters(message, speakerConfig.name);
    const detected = detectResult.filters;
    const isShared = speakerConfig.usesSharedStore === true;
    const filters = buildFiltersFromDetected(detected, isShared);

    // For shared store speakers, add mandatory speaker filter
    // (skip for "all" mode which searches everything)
    let finalFilters = filters;
    if (isShared && speaker !== "all") {
      const speakerFilter: ComparisonFilter = {
        type: "eq",
        key: "speaker",
        value: stripDiacritics(speakerConfig.name),
      };
      if (finalFilters) {
        finalFilters = { type: "and", filters: [speakerFilter, finalFilters] };
      } else {
        finalFilters = speakerFilter;
      }
    }

    // Build tools payload for Responses API
    const toolsPayload = [
      {
        type: "file_search" as const,
        vector_store_ids: [speakerConfig.vectorStoreId],
        max_num_results: 20,
        ...(finalFilters ? { filters: finalFilters } : {}),
      },
    ];

    // Debug payloads for client inspection
    const debugFilterCall = {
      systemPrompt: detectResult.debugSystemPrompt,
      userMessage: detectResult.debugUserMessage,
      detectedFilters: detected,
      builtFilters: filters || null,
    };

    const debugMainCall = {
      model: MODEL,
      input,
      tools: toolsPayload,
    };

    // Call Responses API with file_search
    const stream = await getOpenAI().responses.create({
      model: MODEL,
      input,
      tools: toolsPayload,
      stream: true,
      include: ["file_search_call.results"],
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
        // Emit debug events before streaming the response
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "debug_filter_call", ...debugFilterCall })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "debug_main_call", ...debugMainCall })}\n\n`,
          ),
        );

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

            // Response complete — emit file_search debug + resolve citations
            if (event.type === "response.completed") {
              // Extract file_search results for debug
              const fileSearchResults: any[] = [];
              for (const item of event.response?.output || []) {
                if (item.type === "file_search_call") {
                  fileSearchResults.push({
                    status: item.status,
                    resultCount: item.results?.length ?? 0,
                    results: (item.results || []).map((r: any) => ({
                      file_id: r.file_id,
                      filename: r.filename,
                      score: r.score,
                      attributes: r.attributes,
                    })),
                  });
                }
              }
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "debug_file_search", fileSearchResults })}\n\n`,
                ),
              );

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
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: msg || "Internal server error" },
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

    // Extract video ID from filename
    // Legacy: "transcript_-mXVKLrgBwY.txt" → "-mXVKLrgBwY"
    // Shared: "transcript_-mXVKLrgBwY_speaker-slug.txt" → "-mXVKLrgBwY"
    let videoId: string | undefined;
    let title: string | undefined;

    if (ann.filename) {
      const match = ann.filename.match(/^transcript_([^_]+(?:_[^_]+)?)(?:_[a-z][-a-z0-9]*)?\.txt$/);
      if (match) {
        // For shared store files: transcript_{VIDEOID}_{speakerslug}.txt
        // Video IDs can contain hyphens but speaker slugs are lowercase alpha+hyphens
        // Try the attributes first, fall back to regex
        videoId = match[1];
      }
      // Simpler fallback: just strip "transcript_" prefix and ".txt" suffix, take first 11 chars
      if (!videoId) {
        const simple = ann.filename.match(/^transcript_(.{11})/);
        if (simple) videoId = simple[1];
      }
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
    const usedQuotes = !!quotedText;
    if (!quotedText) {
      quotedText = textWindow.slice(-300);
    }

    const segments = transcriptCache[ann.videoId] || [];
    const { timestamp, method: tsMethod } = findTimestampForQuote(quotedText, segments);

    // Log match method: quote-3, quote-2, quote-1, quote-segment (or 300chars- variants)
    const matchMethod = usedQuotes ? tsMethod : tsMethod.replace("quote", "300chars");

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

    const metaParts = [channel, formattedDate, matchMethod].filter(Boolean);
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
