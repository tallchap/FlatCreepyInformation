"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Send, RotateCcw, Bug, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SPEAKERS } from "@/lib/speakers";
import { SpeakerSelect } from "./speaker-select";
import { MessageBubble } from "./message-bubble";
import { VideoPreviewPane } from "./video-preview-pane";

interface Message {
  role: "user" | "assistant";
  content: string;
}

type SelectedVideo = {
  videoId: string;
  startSec: number;
  title?: string;
} | null;

export function ChatWindow() {
  const [speaker, setSpeaker] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");

  const [isLoading, setIsLoading] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<SelectedVideo>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [debugFilterCall, setDebugFilterCall] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [debugMainCall, setDebugMainCall] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [debugFileSearch, setDebugFileSearch] = useState<any>(null);
  const [debugModal, setDebugModal] = useState<"filter" | "main" | "filesearch" | null>(null);
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
    setInput("");
    setIsLoading(false);
    setSelectedVideo(null);
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
      // Send full conversation history — Responses API uses client-managed state
      const currentMessages = [...messages.slice(0, -1), userMessage]; // exclude placeholder
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speaker,
          message: trimmed,
          messages: currentMessages,
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

            if (event.type === "debug_filter_call") {
              setDebugFilterCall(event);
            } else if (event.type === "debug_main_call") {
              setDebugMainCall(event);
            } else if (event.type === "debug_file_search") {
              setDebugFileSearch(event);
            } else if (event.type === "thread_id") {
              // Legacy — no-op for Responses API
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
            } else if (event.type === "rewrite") {
              // Server rebuilt the text with citation links injected at annotation positions
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === "assistant") {
                  updated[updated.length - 1] = { ...last, content: event.content };
                }
                return updated;
              });
            } else if (event.type === "citations") {
              // Server resolved file citations to real video IDs
              // Replace annotation markers (e.g. 【4:14†source】) with clickable links
              const citationsMap = event.citations as Record<
                string,
                {
                  videoId: string;
                  title: string;
                  timestamp?: number;
                  metadata?: {
                    publishedAt?: string;
                    channel?: string;
                    speakers?: string[];
                    durationSec?: number;
                    viewCount?: number | null;
                  };
                }
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
                    const metaParts = [
                      info.metadata?.publishedAt,
                      info.metadata?.channel,
                    ].filter(Boolean);
                    const label =
                      metaParts.length > 0
                        ? `${info.title} · ${metaParts.join(" · ")}`
                        : info.title;
                    const link = `[${label}](${ytRef})`;
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
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-4 items-start">
      <div className="flex flex-col h-[calc(100vh-160px)] min-w-0">
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
              <div className="text-center space-y-4">
                <p className="text-lg">
                  Chat with{" "}
                  <span className="font-semibold text-gray-600">
                    {SPEAKERS.find((s) => s.slug === speaker)
                      ?.name ?? speaker}
                  </span>
                  &apos;s transcript history
                </p>
                <p className="text-sm">
                  Ask about their views, find specific quotes, or explore topics
                  they&apos;ve discussed.
                </p>
                <div className="flex flex-wrap justify-center gap-2 pt-2">
                  {[
                    "Find me quotes about AI safety",
                    "What are their views on consciousness?",
                    "Summarize their key ideas",
                  ].map((q) => (
                    <button
                      key={q}
                      disabled={isLoading}
                      onClick={() => {
                        setInput(q);
                        // Trigger send on next tick after state updates
                        requestAnimationFrame(() => {
                          const sendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement;
                          sendBtn?.click();
                        });
                      }}
                      className="px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-full text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
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
              onVideoLinkClick={(payload) => setSelectedVideo(payload)}
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
                id="chat-send-btn"
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
            {(debugFilterCall || debugMainCall) && (
              <div className="flex justify-center gap-2 mt-2">
                {debugFilterCall && (
                  <button
                    onClick={() => setDebugModal("filter")}
                    className="text-[10px] px-2 py-0.5 rounded border border-orange-300 text-orange-500 hover:bg-orange-50"
                  >
                    <Bug className="h-3 w-3 inline mr-0.5" />
                    Filter API Call
                  </button>
                )}
                {debugMainCall && (
                  <button
                    onClick={() => setDebugModal("main")}
                    className="text-[10px] px-2 py-0.5 rounded border border-blue-300 text-blue-500 hover:bg-blue-50"
                  >
                    <Bug className="h-3 w-3 inline mr-0.5" />
                    Main API Call
                  </button>
                )}
                {debugFileSearch && (
                  <button
                    onClick={() => setDebugModal("filesearch")}
                    className="text-[10px] px-2 py-0.5 rounded border border-green-300 text-green-600 hover:bg-green-50"
                  >
                    <Bug className="h-3 w-3 inline mr-0.5" />
                    Search Results
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {selectedVideo && (
        <VideoPreviewPane
          videoId={selectedVideo.videoId}
          startSec={selectedVideo.startSec}
          title={selectedVideo.title}
        />
      )}

      {/* Debug modal */}
      {debugModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <h3 className="font-semibold text-sm">
                {debugModal === "filter" ? "GPT-4o-mini Filter Detection Call" : debugModal === "main" ? "OpenAI Responses API Call" : "File Search Results"}
              </h3>
              <button onClick={() => setDebugModal(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-auto p-4">
              <pre className="text-xs whitespace-pre-wrap break-words font-mono text-gray-800">
                {JSON.stringify(
                  debugModal === "filter" ? debugFilterCall : debugModal === "main" ? debugMainCall : debugFileSearch,
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
