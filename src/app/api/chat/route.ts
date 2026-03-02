// src/app/api/chat/route.ts
import { NextRequest } from "next/server";
import OpenAI from "openai";
import { getAssistantBySlug } from "@/lib/assistants";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

    // Create a readable stream that sends the threadId first, then streams text deltas
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Send threadId as the first event
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "thread_id", threadId: currentThreadId })}\n\n`,
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

        run.on("end", () => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "done" })}\n\n`,
            ),
          );
          controller.close();
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
