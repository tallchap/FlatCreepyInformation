"use client";

import { useState, useRef, useEffect } from "react";

type TranscriptLine = { start: number; text: string };

type Snippet = {
  startSec: number;
  endSec: number;
  description: string;
};

type Message = {
  role: "user" | "assistant";
  query?: string;
  promptType?: "bestSnippets" | "aiSafety" | "general";
  snippets?: Snippet[];
};

interface ClipFinderProps {
  transcript: TranscriptLine[];
  onSelectSnippet: (startSec: number, endSec: number) => void;
  onClose: () => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ClipFinder({ transcript, onSelectSnippet, onClose }: ClipFinderProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [allSnippets, setAllSnippets] = useState<Snippet[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Scroll: when loading starts, scroll to bottom to show the dots.
  // When results arrive, scroll to show the user message (not the bottom),
  // so the first snippet cards are visible.
  const lastUserRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bodyRef.current || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "user" || loading) {
      // User just sent a message or loading — scroll to bottom
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    } else if (lastMsg.role === "assistant" && lastUserRef.current) {
      // Results arrived — scroll so the user message is at top
      lastUserRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [messages, loading]);

  const sendQuery = async (query: string, promptType: "bestSnippets" | "aiSafety" | "general") => {
    const userMsg: Message = { role: "user", query };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch("/api/clip-finder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, query, promptType, previousSnippets: allSnippets }),
      });
      const data = await res.json();
      const newSnippets = data.snippets || [];
      const aiMsg: Message = {
        role: "assistant",
        snippets: newSnippets,
        promptType,
      };
      setMessages((prev) => [...prev, aiMsg]);
      setAllSnippets((prev) => [...prev, ...newSnippets]);
    } catch {
      const aiMsg: Message = { role: "assistant", snippets: [] };
      setMessages((prev) => [...prev, aiMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleSnippetClick = (snippet: Snippet) => {
    const key = `${snippet.startSec}-${snippet.endSec}`;
    setSelectedKey(key);
    onSelectSnippet(snippet.startSec, snippet.endSec);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = inputValue.trim();
    if (!q || loading) return;
    setInputValue("");
    sendQuery(q, "general");
  };

  const showAutoprompts = messages.length === 0 && !loading;

  return (
    <div className="flex flex-col h-full">
      {/* Body */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Autoprompts */}
        {showAutoprompts && (
          <>
            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">
              Quick prompts
            </p>
            <button
              onClick={() => sendQuery("Show me the best snippets", "bestSnippets")}
              className="w-full text-left flex items-start gap-2.5 p-3 rounded-lg border border-gray-200 bg-gray-50 hover:bg-green-50 hover:border-green-300 transition-colors"
            >
              <span className="text-base leading-none mt-0.5">🔥</span>
              <div>
                <div className="text-xs font-semibold text-gray-700">Best snippets</div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  Most interesting or quotable moments
                </div>
              </div>
            </button>
            <button
              onClick={() => sendQuery("Show me AI safety quotes", "aiSafety")}
              className="w-full text-left flex items-start gap-2.5 p-3 rounded-lg border border-gray-200 bg-gray-50 hover:bg-green-50 hover:border-green-300 transition-colors"
            >
              <span className="text-base leading-none mt-0.5">🛡️</span>
              <div>
                <div className="text-xs font-semibold text-gray-700">AI safety quotes</div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  Alignment, risk, and governance takes
                </div>
              </div>
            </button>
          </>
        )}

        {/* Messages */}
        {messages.map((msg, i) => {
          if (msg.role === "user") {
            const isOld = i < messages.length - 2;
            const isLastUser = i === messages.length - 1 || i === messages.length - 2;
            return (
              <div
                key={i}
                ref={isLastUser ? lastUserRef : undefined}
                className={`self-end ml-auto max-w-[88%] bg-green-600 text-white px-3 py-1.5 rounded-xl rounded-br-sm text-xs ${
                  isOld ? "opacity-60 text-[11px] py-1 px-2.5" : ""
                }`}
              >
                {msg.query}
              </div>
            );
          }

          const isOld = i < messages.length - 1;
          const snippets = msg.snippets || [];

          if (isOld) {
            return (
              <div key={i} className="space-y-1">
                <p className="text-[9px] font-medium text-gray-400 uppercase tracking-wide">
                  Clip Finder · {snippets.length} snippet{snippets.length !== 1 ? "s" : ""}
                </p>
                {snippets.length > 0 && (
                  <>
                    <SnippetCard
                      snippet={snippets[0]}
                      selected={selectedKey === `${snippets[0].startSec}-${snippets[0].endSec}`}
                      onClick={() => handleSnippetClick(snippets[0])}
                      compact
                    />
                    {snippets.length > 1 && (
                      <p className="text-[10px] text-gray-300 text-center">
                        +{snippets.length - 1} more
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          }

          return (
            <div key={i} className="space-y-1.5">
              <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">
                Clip Finder · {snippets.length} snippet{snippets.length !== 1 ? "s" : ""}
              </p>
              {snippets.length === 0 && (
                <p className="text-xs text-gray-400">No matching clips found. Try a different query.</p>
              )}
              {snippets.map((s, j) => (
                <SnippetCard
                  key={j}
                  snippet={s}
                  selected={selectedKey === `${s.startSec}-${s.endSec}`}
                  onClick={() => handleSnippetClick(s)}
                />
              ))}
            </div>
          );
        })}

        {/* Loading */}
        {loading && (
          <div>
            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">
              Clip Finder
            </p>
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-pulse" />
              <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-pulse [animation-delay:200ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-pulse [animation-delay:400ms]" />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-gray-100 px-3 py-2 flex gap-1.5 items-center">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Find clips about..."
          disabled={loading}
          className="flex-1 border border-gray-200 rounded-full px-3 py-1.5 text-xs bg-gray-50 text-gray-700 placeholder:text-gray-300 focus:outline-none focus:border-green-300 focus:bg-white disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !inputValue.trim()}
          className="w-7 h-7 rounded-full bg-green-600 text-white text-xs flex items-center justify-center disabled:bg-gray-200 disabled:cursor-default"
        >
          ↑
        </button>
      </form>
    </div>
  );
}

function SnippetCard({
  snippet,
  selected,
  onClick,
  compact,
}: {
  snippet: Snippet;
  selected: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  const dur = snippet.endSec - snippet.startSec;
  const key = `${snippet.startSec}-${snippet.endSec}`;

  return (
    <div
      onClick={onClick}
      className={`rounded-lg border cursor-pointer transition-all ${
        selected
          ? "border-green-600 bg-green-50"
          : "border-gray-200 bg-gray-50 hover:border-green-300 hover:bg-green-50/50"
      } ${compact ? "opacity-50" : ""}`}
    >
      <div className={`flex items-center gap-1.5 ${compact ? "px-2.5 pt-1.5" : "px-2.5 pt-2"}`}>
        <span className="text-xs font-bold text-green-600 tabular-nums">
          {formatTime(snippet.startSec)} – {formatTime(snippet.endSec)}
        </span>
        <span className="text-[9px] text-gray-300 ml-auto">{formatDuration(dur)}</span>
      </div>
      <p className={`px-2.5 text-gray-500 leading-snug ${compact ? "pb-1.5 text-[10px]" : "pb-2 text-[11px]"}`}>
        {snippet.description}
      </p>
    </div>
  );
}
