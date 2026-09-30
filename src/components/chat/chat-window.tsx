"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, Bug, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

import { Composer } from "../clip-chat/composer";
import {
  CHAT_HANDOFF_KEY,
  FEATURED_SPEAKERS,
  readChatHandoff,
} from "../clip-chat/speakers";
import styles from "../clip-chat/clip-chat.module.css";
import { SpeakerSelect, speakerInitial } from "./speaker-select";
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

const PREVIEW_MESSAGES: Message[] = [
  { role: "user", content: "Find a short Sam Altman clip about AGI." },
  {
    role: "assistant",
    content:
      "**A short moment about AGI**\n\n“One idea would be that AGI really is going to happen.”\n\n[The race to build AI that benefits humanity · TED Tech · 1:06:05](youtube:Q3E5fagbcsA:3965)\n\nWant a different angle? Ask for a more surprising prediction or a clip about the risks.",
  },
];

export function ChatWindow({ preview = false }: { preview?: boolean }) {
  const [speaker, setSpeaker] = useState<string>(FEATURED_SPEAKERS[0].slug);
  const [speakerName, setSpeakerName] = useState<string>(
    FEATURED_SPEAKERS[0].name,
  );
  const [messages, setMessages] = useState<Message[]>(
    preview ? PREVIEW_MESSAGES : [],
  );
  const [input, setInput] = useState("");

  const [isLoading, setIsLoading] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<SelectedVideo>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [debugFilterCall, setDebugFilterCall] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [debugMainCall, setDebugMainCall] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [debugFileSearch, setDebugFileSearch] = useState<any>(null);
  const [debugModal, setDebugModal] = useState<
    "filter" | "main" | "filesearch" | null
  >(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (preview) return;
    // Defer consumption so React Strict Mode's setup/cleanup replay cannot send twice.
    const timer = window.setTimeout(() => {
      try {
        const pending = readChatHandoff(
          sessionStorage.getItem(CHAT_HANDOFF_KEY),
        );
        sessionStorage.removeItem(CHAT_HANDOFF_KEY);
        if (!pending) return;
        setSpeaker(pending.speaker);
        setSpeakerName(pending.name);
        void handleSend(pending.prompt, {
          slug: pending.speaker,
          name: pending.name,
        });
      } catch {
        // Direct /chat still works when browser storage is unavailable.
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      controllerRef.current?.abort();
    };
    // This is a one-time handoff; subsequent messages use the current conversation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (messages.length && !preview) scrollToBottom();
  }, [messages, scrollToBottom, preview]);

  function handleNewConversation() {
    setMessages([]);
    setInput("");
    setIsLoading(false);
    setSelectedVideo(null);
    setDebugFilterCall(null);
    setDebugMainCall(null);
    setDebugFileSearch(null);
    setDebugModal(null);
  }

  function handleSpeakerChange(value: string, name?: string) {
    setSpeaker(value);
    setSpeakerName(name || value);
    handleNewConversation();
  }

  async function handleSend(
    overrideMessage?: string,
    initialSpeaker?: { slug: string; name: string },
  ) {
    const trimmed = (overrideMessage ?? input).trim();
    if (!trimmed || !speaker || sendingRef.current) return;
    sendingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;

    const userMessage: Message = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setDebugFilterCall(null);
    setDebugMainCall(null);
    setDebugFileSearch(null);

    // Add a placeholder assistant message that we'll stream into
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      if (preview) {
        await new Promise((resolve) => window.setTimeout(resolve, 550));
        setMessages((prev) => [
          ...prev.slice(0, -1),
          {
            role: "assistant",
            content:
              "This is a design preview, so no new search was run. On the real chat page, your follow-up searches the selected speaker’s conversations while keeping the earlier messages in context.",
          },
        ]);
        return;
      }
      // Send full conversation history — Responses API uses client-managed state
      const currentMessages = [...messages, userMessage]; // state above has not rendered yet
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speaker: initialSpeaker?.slug ?? speaker,
          speakerName: initialSpeaker?.name ?? speakerName,
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
        if (controller.signal.aborted) return;
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
                  updated[updated.length - 1] = {
                    ...last,
                    content: event.content,
                  };
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
                    const ytRef =
                      info.timestamp !== undefined
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
      if (controller.signal.aborted) return;
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
      sendingRef.current = false;
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }

  return (
    <div
      className={`${styles.surface} ${styles.chatGrid} ${selectedVideo ? styles.withVideo : ""}`}
    >
      <section className={styles.chat}>
        <div className={styles.chatHeader}>
          <div className={styles.chatIdentity}>
            <SpeakerSelect
              value={speaker}
              name={speakerName}
              onValueChange={handleSpeakerChange}
              disabled={isLoading}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewConversation}
            disabled={isLoading}
          >
            <RotateCcw size={13} /> New chat
          </Button>
        </div>
        {messages.length === 0 ? (
          <div className={styles.chatEmpty}>
            <div
              className={styles.chatInitial}
              data-speaker-initial
              aria-hidden="true"
            >
              {speakerInitial(speaker === "all" ? "All speakers" : speakerName)}
            </div>
            <h1>What would you like to find?</h1>
            <p>
              Describe a moment, an idea, or something{" "}
              {speaker === "all" ? "you heard" : `${speakerName} said`}.
            </p>
          </div>
        ) : (
          <div
            className={styles.messages}
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
            aria-busy={isLoading}
          >
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
                onVideoLinkClick={setSelectedVideo}
                onSuggestionClick={(text) => handleSend(text)}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
        <div className={styles.chatReply}>
          <Composer
            showSuggestions={messages.length === 0}
            speaker={speaker}
            name={speakerName}
            value={input}
            onChange={setInput}
            onSend={() => handleSend()}
            busy={isLoading}
          />
          <div className={styles.chatTools}>
            <button
              onClick={() =>
                window.open(
                  `/api/export-transcripts?speaker=${encodeURIComponent(speakerName)}`,
                  "_blank",
                )
              }
              disabled={isLoading}
            >
              <Download className="inline mr-1" size={11} />
              Export transcripts
            </button>
            {debugFilterCall && (
              <button onClick={() => setDebugModal("filter")}>
                <Bug className="inline mr-1" size={11} />
                Filter API call
              </button>
            )}
            {debugMainCall && (
              <button onClick={() => setDebugModal("main")}>
                <Bug className="inline mr-1" size={11} />
                Main API call
              </button>
            )}
            {debugFileSearch && (
              <button onClick={() => setDebugModal("filesearch")}>
                <Bug className="inline mr-1" size={11} />
                Search results
              </button>
            )}
          </div>
        </div>
      </section>
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
                {debugModal === "filter"
                  ? "GPT-4o-mini Filter Detection Call"
                  : debugModal === "main"
                    ? "OpenAI Responses API Call"
                    : "File Search Results"}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const data =
                      debugModal === "filter"
                        ? debugFilterCall
                        : debugModal === "main"
                          ? debugMainCall
                          : debugFileSearch;
                    navigator.clipboard.writeText(
                      JSON.stringify(data, null, 2),
                    );
                  }}
                  className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-600"
                >
                  Copy
                </button>
                <button
                  onClick={() => setDebugModal(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="overflow-auto p-4">
              <pre className="text-xs whitespace-pre-wrap break-words font-mono text-gray-800">
                {JSON.stringify(
                  debugModal === "filter"
                    ? debugFilterCall
                    : debugModal === "main"
                      ? debugMainCall
                      : debugFileSearch,
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
