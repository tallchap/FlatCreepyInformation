/* src/components/search/match-snippets.tsx */
"use client";

import Link from "next/link";

/* ───────────────────────── helpers ───────────────────────── */

/** Seconds → pretty label "m:ss" or "h:mm:ss" */
function fmt(seconds: number): string {
  const iso = new Date(seconds * 1_000).toISOString();
  return seconds < 3600 ? iso.slice(14, 19) : iso.slice(11, 19);
}

/* ───────────────────────── component ─────────────────────── */

type Props = {
  /** YouTube video id (e.g. "dQw4w9WgXcQ"). */
  videoId: string;
  /** Snippet objects with pre-computed timestamps returned by search. */
  snippets: { text: string; seconds: number | null }[];
  className?: string;
  onTimestampClick?: (seconds: number, snippetHtml?: string) => void;
};

export function MatchSnippets({
  videoId,
  snippets,
  className,
  onTimestampClick,
}: Props) {
  return (
    <div className={className}>
      <div className="text-sm text-gray-800 mb-2 font-medium">
        Matching content:
      </div>

      {snippets.map((snippet, i) => {
        const seconds = snippet.seconds;
        const isClickable = seconds !== null;

        const content = (
          <>
            <span
              className={isClickable ? "text-blue-600 hover:underline shrink-0" : "text-gray-400 shrink-0"}
            >
              {isClickable ? fmt(seconds) : "--:--"}
            </span>

            {/* snippet text with <mark>…</mark> highlights preserved */}
            <span
              className="grow"
              dangerouslySetInnerHTML={{ __html: snippet.text }}
            />
          </>
        );

        if (isClickable && onTimestampClick) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => onTimestampClick(seconds, snippet.text)}
              className="bg-gray-50 p-3 rounded text-sm mb-2 flex gap-2 items-start w-full text-left"
            >
              {content}
            </button>
          );
        }

        if (isClickable) {
          return (
            <Link
              key={i}
              href={`/video/${videoId}?t=${seconds}`}
              className="bg-gray-50 p-3 rounded text-sm mb-2 flex gap-2 items-start"
            >
              {content}
            </Link>
          );
        }

        return (
          <div
            key={i}
            className="bg-gray-50 p-3 rounded text-sm mb-2 flex gap-2 items-start"
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
