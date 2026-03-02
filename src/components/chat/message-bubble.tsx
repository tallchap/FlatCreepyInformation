"use client";

import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}

/**
 * Turn markdown-ish links into clickable anchors, convert
 * youtube:VIDEO_ID citations into Snippysaurus video links,
 * strip OpenAI file-search annotations, and preserve formatting.
 */
function formatContent(text: string): string {
  return (
    text
      // Remove OpenAI file-search annotation markers like 【4:14†source】
      .replace(/[\u3010][^\u3011]*[\u3011]/g, "")
      // Bold **text**
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      // Snippysaurus video links: [Video Title](youtube:VIDEO_ID) or [Video Title](youtube:VIDEO_ID:SECONDS)
      // Use .+? to allow square brackets inside the title (e.g. "[Percontations]")
      .replace(
        /\[(.+?)\]\(youtube:([\w-]{11})(?::(\d+))?\)/g,
        (_match, title: string, videoId: string, seconds?: string) => {
          const href = seconds ? `/video/${videoId}?t=${seconds}` : `/video/${videoId}`;
          return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 underline text-blue-600 hover:text-blue-800"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="inline"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>${title}</a>`;
        },
      )
      // Regular markdown links [text](url)
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" class="underline text-blue-600 hover:text-blue-800">$1</a>',
      )
      // Bare YouTube URLs
      .replace(
        /(https:\/\/youtu\.be\/([\w-]{11}))/g,
        '<a href="/video/$2" target="_blank" rel="noopener noreferrer" class="underline text-blue-600 hover:text-blue-800">$1</a>',
      )
      // Newlines
      .replace(/\n/g, "<br />")
  );
}

export function MessageBubble({
  role,
  content,
  isStreaming,
}: MessageBubbleProps) {
  const isUser = role === "user";

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
            dangerouslySetInnerHTML={{ __html: formatContent(content) }}
          />
        )}
      </div>
    </div>
  );
}
