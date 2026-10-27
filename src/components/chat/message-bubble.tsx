"use client";

import { formatChatContent } from "@/lib/chat-content";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  role: "user" | "assistant";
  messageIndex?: number;
  content: string;
  isStreaming?: boolean;
  onVideoLinkClick?: (payload: {
    videoId: string;
    startSec: number;
    title?: string;
    citationIndex: number;
  }) => void;
  onSuggestionClick?: (suggestion: string) => void;
}

export function MessageBubble({
  role,
  messageIndex,
  content,
  isStreaming,
  onVideoLinkClick,
  onSuggestionClick,
}: MessageBubbleProps) {
  const isUser = role === "user";

  function handleAssistantContentClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;

    // Handle suggestion clicks
    const suggestion = target.closest(
      "[data-suggestion]",
    ) as HTMLElement | null;
    if (suggestion && onSuggestionClick) {
      e.preventDefault();
      const text = decodeURIComponent(suggestion.dataset.suggestion || "");
      if (text) onSuggestionClick(text);
      return;
    }

    // Handle video link clicks
    if (!onVideoLinkClick || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const link = target.closest("a[data-video-id]") as HTMLAnchorElement | null;
    if (!link) return;

    const videoId = link.dataset.videoId;
    if (!videoId) return;

    e.preventDefault();
    const startSec = Number(link.dataset.startSec || "0") || 0;
    const encodedTitle = link.dataset.videoTitle;
    const title = encodedTitle
      ? decodeURIComponent(encodedTitle)
      : link.textContent || undefined;
    const citationIndex = Array.from(
      e.currentTarget.querySelectorAll("a[data-video-id]"),
    ).indexOf(link);
    onVideoLinkClick({ videoId, startSec, title, citationIndex });
  }

  return (
    <div
      data-chat-message-index={messageIndex}
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[92%] sm:max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "bg-[#f5ecd2] border-[1.5px] border-[#e6dfcc] text-[#1f2e25]"
            : "bg-white border-[1.5px] border-[#e6dfcc] text-[#1f2e25]",
          isStreaming && "animate-pulse",
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div
            className="prose prose-sm max-w-none"
            onClick={handleAssistantContentClick}
            dangerouslySetInnerHTML={{ __html: formatChatContent(content) }}
          />
        )}
      </div>
    </div>
  );
}
