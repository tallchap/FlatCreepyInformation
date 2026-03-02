"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SPEAKER_ASSISTANTS } from "@/lib/assistants";
import { SpeakerSelect } from "./speaker-select";
import { MessageBubble } from "./message-bubble";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export function ChatWindow() {
  const [speaker, setSpeaker] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  function handleNewConversation() {
    setMessages([]);
    setThreadId(null);
    setInput("");
    setIsLoading(false);
  }

  function handleSpeakerChange(value: string) {
    setSpeaker(value);
    handleNewConversation();
  }

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || !speaker || isLoading) return;

    const userMessage: Message = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    // Add a placeholder assistant message that we'll stream into
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speaker,
          message: trimmed,
          threadId,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Request failed");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === "thread_id") {
              setThreadId(event.threadId);
            } else if (event.type === "text_delta") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    content: last.content + event.text,
                  };
                }
                return updated;
              });
            } else if (event.type === "citations") {
              // Server resolved file citations to real video IDs
              // Replace annotation markers (e.g. 【4:14†source】) with clickable links
              const citationsMap = event.citations as Record<
                string,
                { videoId: string; title: string; timestamp?: number }
              >;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === "assistant") {
                  let content = last.content;
                  for (const [marker, info] of Object.entries(citationsMap)) {
                    // Include timestamp if available: youtube:VIDEO_ID:SECONDS
                    const ytRef = info.timestamp !== undefined
                      ? `youtube:${info.videoId}:${Math.floor(info.timestamp)}`
                      : `youtube:${info.videoId}`;
                    const link = `[${info.title}](${ytRef})`;
                    content = content.split(marker).join(link);
                  }
                  updated[updated.length - 1] = { ...last, content };
                }
                return updated;
              });
            } else if (event.type === "error") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    content: event.error,
                  };
                }
                return updated;
              });
            }
          } catch {
            // skip malformed JSON lines
          }
        }
      }
    } catch (error) {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            content:
              error instanceof Error
                ? error.message
                : "Something went wrong. Please try again.",
          };
        }
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-160px)] max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <SpeakerSelect
            value={speaker}
            onValueChange={handleSpeakerChange}
            disabled={isLoading}
          />
          {messages.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleNewConversation}
              disabled={isLoading}
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              New Chat
            </Button>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto py-4 space-y-4">
        {!speaker && (
          <div className="flex items-center justify-center h-full text-gray-400">
            <p className="text-lg">Select a speaker to start chatting</p>
          </div>
        )}

        {speaker && messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-400">
            <div className="text-center space-y-2">
              <p className="text-lg">
                Chat with{" "}
                <span className="font-semibold text-gray-600">
                  {SPEAKER_ASSISTANTS.find((s) => s.slug === speaker)
                    ?.name ?? speaker}
                </span>
                &apos;s transcript history
              </p>
              <p className="text-sm">
                Ask about their views, find specific quotes, or explore topics
                they&apos;ve discussed.
              </p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            role={msg.role}
            content={msg.content}
            isStreaming={
              isLoading &&
              i === messages.length - 1 &&
              msg.role === "assistant"
            }
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {speaker && (
        <div className="border-t border-gray-200 pt-4">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about their views, find quotes, explore topics..."
              className="flex-1 resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#99cc66] focus:border-transparent min-h-[48px] max-h-[120px]"
              rows={1}
              disabled={isLoading}
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className="bg-[#99cc66] hover:bg-[#88bb55] text-white rounded-xl h-[48px] w-[48px] p-0"
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
          <p className="text-xs text-gray-400 mt-2 text-center">
            Responses are based on video transcript data. Always verify quotes
            against the original videos.
          </p>
        </div>
      )}
    </div>
  );
}
