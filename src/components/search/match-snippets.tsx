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
  snippets: { text: string; seconds: number }[];
  className?: string;
};

export function MatchSnippets({ videoId, snippets, className }: Props) {
  return (
    <div className={className}>
      <div className="text-sm text-gray-800 mb-2 font-medium">
        Matching content:
      </div>

      {snippets.map((snippet, i) => {
        const seconds = snippet.seconds;

        return (
          <div
            key={i}
            className="bg-gray-50 p-3 rounded text-sm mb-2 flex gap-2 items-start"
          >
            {/* clickable timestamp */}
            <Link
              href={`/video/${videoId}?t=${seconds}`}
              className="text-blue-600 hover:underline shrink-0"
            >
              {fmt(seconds)}
            </Link>

            {/* snippet text with <mark>…</mark> highlights preserved */}
            <span
              className="grow"
              dangerouslySetInnerHTML={{ __html: snippet.text }}
            />
          </div>
        );
      })}
    </div>
  );
}
