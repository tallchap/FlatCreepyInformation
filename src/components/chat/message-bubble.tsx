"use client";

import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  onVideoLinkClick?: (payload: { videoId: string; startSec: number; title?: string }) => void;
  onSuggestionClick?: (suggestion: string) => void;
}

/**
 * Clean a numbered suggestion line: strip number prefix, leading "or ",
 * trailing comma/period, and trim whitespace.
 */
function cleanSuggestion(raw: string): string {
  return raw
    .replace(/^\d+\.\s*/, "")
    .replace(/^or\s+/i, "")
    .replace(/[,.]$/, "")
    .trim();
}

/**
 * Turn markdown-ish links into clickable anchors, convert
 * youtube:VIDEO_ID citations into Snippysaurus video links,
 * strip OpenAI file-search annotations, make numbered follow-ups
 * clickable, and preserve formatting.
 */
function formatContent(text: string): string {
  return (
    text
      // Remove OpenAI file-search annotation markers like 【4:14†source】
      .replace(/[\u3010][^\u3011]*[\u3011]/g, "")
      // Bold **text**
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      // Snippysaurus video links: [Video Title](youtube:VIDEO_ID) or [Video Title](youtube:VIDEO_ID:SECONDS)
      .replace(
        /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(youtube:([\w-]{11})(?::(\d+(?:\.\d+)?))?\)/g,
        (_match, title: string, videoId: string, seconds?: string) => {
          const startSec = seconds ? Math.floor(parseFloat(seconds)) : 0;
          const href = `/video/${videoId}?t=${startSec}`;
          return `<a href="${href}" data-video-id="${videoId}" data-start-sec="${startSec}" data-video-title="${encodeURIComponent(title)}" class="inline-flex items-center gap-1 underline text-blue-600 hover:text-blue-800"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="inline"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>${title}</a>`;
        },
      )
      // Regular markdown links [text](url)
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" class="underline text-blue-600 hover:text-blue-800">$1</a>',
      )
      // Bare youtu.be URLs
      .replace(
        /(https:\/\/youtu\.be\/([\w-]{11}))/g,
        '<a href="/video/$2" data-video-id="$2" data-start-sec="0" class="underline text-blue-600 hover:text-blue-800">$1</a>',
      )
      // Numbered follow-up suggestions (e.g. "1. find quotes about...")
      // Convert to clickable spans with cleaned text
      .replace(
        /^(\d+\.\s+.+)$/gm,
        (_match, line: string) => {
          const cleaned = cleanSuggestion(line);
          return `<span data-suggestion="${encodeURIComponent(cleaned)}" class="inline-block px-3 py-1 text-sm bg-white border border-gray-200 rounded-full text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors cursor-pointer">${line.replace(/^\d+\.\s*/, "").replace(/^or\s+/i, "").replace(/[,.]$/, "").trim()}</span>`;
        },
      )
      // Newlines
      .replace(/\n/g, "<br />")
      // Wrap consecutive suggestion pills in a flex container and remove <br /> between them
      .replace(
        /(<span data-suggestion="[^"]*" class="inline-block[^>]*>.*?<\/span>)(?:<br \/>)*/g,
        "$1",
      )
      .replace(
        /((?:<span data-suggestion="[^"]*" class="inline-block[^>]*>.*?<\/span>)+)/g,
        '<div class="flex flex-wrap gap-2 mt-2">$1</div>',
      )
  );
}

export function MessageBubble({
  role,
  content,
  isStreaming,
  onVideoLinkClick,
  onSuggestionClick,
}: MessageBubbleProps) {
  const isUser = role === "user";

  function handleAssistantContentClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;

    // Handle suggestion clicks
    const suggestion = target.closest("[data-suggestion]") as HTMLElement | null;
    if (suggestion && onSuggestionClick) {
      e.preventDefault();
      const text = decodeURIComponent(suggestion.dataset.suggestion || "");
      if (text) onSuggestionClick(text);
      return;
    }

    // Handle video link clicks
    if (!onVideoLinkClick) return;
    const link = target.closest("a[data-video-id]") as HTMLAnchorElement | null;
    if (!link) return;

    const videoId = link.dataset.videoId;
    if (!videoId) return;

    e.preventDefault();
    const startSec = Number(link.dataset.startSec || "0") || 0;
    const encodedTitle = link.dataset.videoTitle;
    const title = encodedTitle ? decodeURIComponent(encodedTitle) : link.textContent || undefined;
    onVideoLinkClick({ videoId, startSec, title });
  }

  return (
    <div
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "bg-[#99cc66] text-gray-900"
            : "bg-white border border-gray-200 text-gray-800",
          isStreaming && "animate-pulse",
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div
            className="prose prose-sm max-w-none"
            onClick={handleAssistantContentClick}
            dangerouslySetInnerHTML={{ __html: formatContent(content) }}
          />
        )}
      </div>
    </div>
  );
}
