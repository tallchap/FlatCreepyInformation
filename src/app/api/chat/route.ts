// src/app/api/chat/route.ts
import { NextRequest } from "next/server";
import OpenAI from "openai";
import { getAssistantBySlug } from "@/lib/assistants";
import { fetchTranscript, fetchVideoMeta } from "@/lib/bigquery";
import citationMap from "@/lib/file-citation-map.json";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type CitationMetadata = {
  publishedAt?: string;
  channel?: string;
  speakers?: string[];
  durationSec?: number;
  viewCount?: number | null;
};

// Build a flat lookup: file_id → citation entry (+ optional metadata)
type CitationEntry = {
  videoId: string;
  title: string;
  metadata?: CitationMetadata;
};
const FILE_ID_LOOKUP: Record<string, CitationEntry> = {};
for (const speaker of Object.values(citationMap)) {
  const files = (speaker as { files: Record<string, CitationEntry> }).files;
  for (const [fileId, meta] of Object.entries(files)) {
    FILE_ID_LOOKUP[fileId] = meta;
  }
}

/**
 * Given a snippet of quoted text and a parsed transcript (segments with timestamps),
 * find the best matching timestamp by searching for overlapping words.
 */
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

function findTimestampForQuote(
  quote: string,
  segments: { start: number | null; text: string }[],
): number | null {
  if (!quote || segments.length === 0) return null;

  // Normalize quote: lowercase, collapse whitespace
  const normalizedQuote = quote.toLowerCase().replace(/\s+/g, " ").trim();
  const quoteWords = normalizedQuote.split(" ").filter((w) => w.length > 3);
  if (quoteWords.length === 0) return null;

  let bestScore = 0;
  let bestTimestamp: number | null = null;

  // Check each segment and a sliding window of consecutive segments
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.start === null) continue;

    // Build a window of text from this segment and the next few
    let windowText = "";
    for (let j = i; j < Math.min(i + 5, segments.length); j++) {
      windowText += " " + segments[j].text;
    }
    const normalizedWindow = windowText.toLowerCase().replace(/\s+/g, " ");

    // Count how many quote words appear in this window
    let score = 0;
    for (const word of quoteWords) {
      if (normalizedWindow.includes(word)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestTimestamp = seg.start;
    }
  }

  // Only return if we matched at least 30% of the significant words
  return bestScore >= quoteWords.length * 0.3 ? bestTimestamp : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { speaker, message, threadId } = body as {
      speaker: string;
      message: string;
      threadId?: string;
    };

    if (!speaker || !message) {
      return Response.json(
        { error: "speaker and message are required" },
        { status: 400 },
      );
    }

    const assistant = getAssistantBySlug(speaker);
    if (!assistant) {
      return Response.json({ error: "Unknown speaker" }, { status: 400 });
    }

    // Create or reuse thread
    let currentThreadId = threadId;
    if (!currentThreadId) {
      const thread = await openai.beta.threads.create();
      currentThreadId = thread.id;
    }

    // Add user message to thread
    await openai.beta.threads.messages.create(currentThreadId, {
      role: "user",
      content: message,
    });

    // Run the assistant and stream the response
    const run = openai.beta.threads.runs.stream(currentThreadId, {
      assistant_id: assistant.assistantId,
    });

    // Create a readable stream that sends the threadId first, then streams text deltas,
    // and after completion sends resolved citations based on file_id → video_id mapping
    const encoder = new TextEncoder();
    const capturedThreadId = currentThreadId;

    const stream = new ReadableStream({
      async start(controller) {
        // Send threadId as the first event
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "thread_id", threadId: capturedThreadId })}\n\n`,
          ),
        );

        run.on("textDelta", (delta) => {
          if (delta.value) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text_delta", text: delta.value })}\n\n`,
              ),
            );
          }
        });

        run.on("end", async () => {
          // After the run completes, fetch the final message to get file citation annotations
          try {
            const messages = await openai.beta.threads.messages.list(
              capturedThreadId,
              { limit: 1, order: "desc" },
            );
            const lastMsg = messages.data[0];
            if (lastMsg && lastMsg.role === "assistant") {
              const citations: Record<
                string,
                {
                  videoId: string;
                  title: string;
                  timestamp?: number;
                  metadata?: CitationMetadata;
                }
              > = {};

              // First pass: collect citation info and the quoted text before each marker
              const pendingCitations: {
                marker: string;
                videoId: string;
                title: string;
                quotedText: string;
                metadata?: CitationMetadata;
              }[] = [];

              for (const block of lastMsg.content) {
                if (block.type === "text" && block.text.annotations) {
                  const fullText = block.text.value;
                  for (const ann of block.text.annotations) {
                    if (
                      ann.type === "file_citation" &&
                      ann.file_citation?.file_id
                    ) {
                      const entry = FILE_ID_LOOKUP[ann.file_citation.file_id];
                      if (entry) {
                        // Extract ~200 chars of text before the annotation marker
                        const textBefore = fullText
                          .substring(Math.max(0, ann.start_index - 200), ann.start_index)
                          .trim();
                        pendingCitations.push({
                          marker: ann.text,
                          videoId: entry.videoId,
                          title: entry.title,
                          quotedText: textBefore,
                          metadata: entry.metadata,
                        });
                      }
                    }
                  }
                }
              }

              // Second pass: fetch transcripts for unique videoIds and find timestamps
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
                        // Populated from source map when available; null placeholder otherwise.
                        viewCount: null,
                      };
                    }
                  } catch {
                    // leave metadata cache empty for this video
                  }
                }),
              );

              // Third pass: build citations with timestamps
              for (const pc of pendingCitations) {
                const segments = transcriptCache[pc.videoId] || [];
                const timestamp = findTimestampForQuote(pc.quotedText, segments);
                const mergedMetadata: CitationMetadata | undefined = {
                  ...(metadataCache[pc.videoId] || {}),
                  ...(pc.metadata || {}),
                };

                citations[pc.marker] = {
                  videoId: pc.videoId,
                  title: pc.title,
                  ...(timestamp !== null && { timestamp: Math.floor(timestamp) }),
                  ...(Object.keys(mergedMetadata).length > 0 && {
                    metadata: mergedMetadata,
                  }),
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
          } catch (err) {
            console.error("Error fetching citations:", err);
          }

          try {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "done" })}\n\n`,
              ),
            );
            controller.close();
          } catch {
            /* stream already closed/cancelled */
          }
        });

        run.on("error", (error) => {
          console.error("Run error:", error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", error: "An error occurred while processing your request." })}\n\n`,
            ),
          );
          controller.close();
        });
      },
    });

    return new Response(stream, {
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
