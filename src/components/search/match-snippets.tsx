/* src/components/search/match-snippets.tsx */
"use client";

import Link from "next/link";

/* ───────────────────────── helpers ───────────────────────── */

/** Convert a timestamp string to seconds.
 *  • `[05:32]` → 332
 *  • `1:23`    → 83
 *  • `816.76`  → 816   (decimals are floored)
 */
function toSeconds(raw: string): number {
  const clean = raw.replace(/^\[|\]$/g, "");          // strip []
  if (clean.includes(":")) {
    // h:mm:ss or mm:ss
    const parts = clean.split(":").map(Number).reverse(); // sec, min, hour
    return parts.reduce((s, n, i) => s + n * 60 ** i, 0);
  }
  return Math.floor(parseFloat(clean));               // plain seconds
}

/** Seconds → pretty label “m:ss” or “h:mm:ss” */
function fmt(seconds: number): string {
  const iso = new Date(seconds * 1_000).toISOString();
  return seconds < 3600 ? iso.slice(14, 19) : iso.slice(11, 19);
}

/* ───────────────────────── regexes ───────────────────────── */

const RE_MMSS   = /\[?(\d{1,2}:)?\d{1,2}:\d{2}\]?/;         // [05:32] 13:57
const RE_SECDEC = /\b(\d+(?:\.\d+)?)\s*:/;                  // 816.76: 1290.44:

/* ───────────────────────── component ─────────────────────── */

type Props = {
  /** YouTube video id (e.g. “dQw4w9WgXcQ”). */
  videoId: string;
  /** Snippet strings returned by search. */
  snippets: string[];
  className?: string;
};

export function MatchSnippets({ videoId, snippets, className }: Props) {
  return (
    <div className={className}>
      <div className="text-sm text-gray-800 mb-2 font-medium">
        Matching content:
      </div>

      {snippets.map((snippet, i) => {
        /* — find earliest timestamp token in the snippet — */
        let tsRaw = "";
        const mm  = snippet.match(RE_MMSS);
        const ss  = snippet.match(RE_SECDEC);

        if (mm && ss) {
          tsRaw = mm.index! < ss.index! ? mm[0] : ss[1];
        } else if (mm) {
          tsRaw = mm[0];
        } else if (ss) {
          tsRaw = ss[1];               // capture group (no trailing colon)
        } else {
          tsRaw = "0";
        }

        const seconds = toSeconds(tsRaw);

        /* — clean the snippet for display (strip *all* timestamp tokens) — */
        const body = snippet
          .replace(new RegExp(RE_MMSS, "g"), "")
          .replace(new RegExp(RE_SECDEC, "g"), "")
          .trim();

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
              dangerouslySetInnerHTML={{ __html: body }}
            />
          </div>
        );
      })}
    </div>
  );
}
