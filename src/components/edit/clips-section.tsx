"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { AutoSnippet } from "@/lib/types/clip";

const DESC_LIMIT = 220;

function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf(" ", limit);
  return text.slice(0, cut > 0 ? cut : limit).replace(/[,;:\-–—'")\]}\s]+$/, "") + "...";
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function SnippetDetails({ snippet, videoId }: { snippet: AutoSnippet; videoId: string }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [playerHeight, setPlayerHeight] = useState(0);
  const [descExpanded, setDescExpanded] = useState(false);
  const transcriptId = useId();

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const observer = new ResizeObserver(([entry]) => setPlayerHeight(entry.contentRect.height));
    observer.observe(player);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-1 items-start gap-3 p-3 pt-0 sm:p-4 sm:pt-0 lg:grid-cols-5">
      <div className="min-w-0 lg:col-span-3">
        <div ref={playerRef} data-testid="snippet-player" className="relative aspect-video overflow-hidden rounded-xl bg-black">
          <video
            src={snippet.gcsUrl}
            controls
            playsInline
            preload="none"
            poster={`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`}
            aria-label={snippet.title}
            className="h-full w-full object-contain"
          />
          <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-md bg-[#153b2a]/95 px-2.5 py-1 text-xs font-semibold text-white">
            {formatDuration(snippet.durationMs)} clip
          </span>
        </div>
        {snippet.description && (
          <p className="mt-3 text-sm leading-relaxed text-gray-600">
            {descExpanded ? snippet.description : truncateAtWord(snippet.description, DESC_LIMIT)}
            {snippet.description.length > DESC_LIMIT && (
              <> <button onClick={() => setDescExpanded(!descExpanded)} aria-expanded={descExpanded} className="font-medium text-green-700 hover:underline">
                {descExpanded ? "Show less" : "See more"}
              </button></>
            )}
          </p>
        )}
      </div>
      <div className="min-w-0 space-y-3 lg:col-span-2">
        <section
          aria-labelledby={transcriptId}
          data-testid="snippet-transcript"
          className="flex h-64 min-h-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white lg:h-[var(--snippet-player-height)]"
          style={{ "--snippet-player-height": playerHeight ? `${playerHeight}px` : "16rem" } as CSSProperties}
        >
          <h4 id={transcriptId} className="shrink-0 border-b border-gray-100 px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-500">
            Snippet transcript
          </h4>
          <div tabIndex={0} role="region" aria-label="Snippet transcript text" className="min-h-0 flex-1 overflow-y-auto p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-green-600">
            {snippet.transcript?.trim() ? (
              <p className="whitespace-pre-line text-sm leading-relaxed text-gray-700">{snippet.transcript.replace(/\n{2,}/g, "\n").trim()}</p>
            ) : (
              <p className="text-sm italic text-gray-400">No transcript available for this snippet</p>
            )}
          </div>
        </section>
        <div className="flex justify-end">
          <a href={snippet.gcsUrl} target="_blank" rel="noopener noreferrer" download className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#DC2626] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#B91C1C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download Snippet
          </a>
        </div>
      </div>
    </div>
  );
}

export function ClipsSection({ videoId }: { videoId: string }) {
  const [snippets, setSnippets] = useState<AutoSnippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sectionId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSnippets([]);
    setActiveId(null);
    fetch(`/api/snippets/auto?videoId=${videoId}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load snippets");
        return response.json();
      })
      .then((data: AutoSnippet[]) => {
        if (controller.signal.aborted) return;
        setSnippets(data);
        setActiveId(data[0]?.snippetId ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [videoId]);

  if (loading || snippets.length === 0) return null;

  return (
    <section className="space-y-3" data-testid="ready-made-snippets" aria-labelledby={`${sectionId}-title`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`${sectionId}-title`} className="text-2xl font-bold text-gray-900">Ready-Made Snippet{snippets.length > 1 ? "s" : ""}</h2>
        {snippets.length > 1 && <span className="shrink-0 text-xs text-gray-500">{snippets.length} available</span>}
      </div>
      <div className="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {snippets.map((snippet, index) => {
          const expanded = snippet.snippetId === activeId;
          const headingId = `${sectionId}-heading-${index}`;
          const panelId = `${sectionId}-panel-${index}`;
          return (
            <article key={snippet.snippetId} data-testid="snippet-row">
              <h3>
                <button
                  id={headingId}
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => setActiveId(expanded ? null : snippet.snippetId)}
                  className={`flex w-full items-center gap-3 p-3 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-green-600 sm:gap-4 sm:p-4 ${expanded ? "bg-[#f5f9f1]" : "hover:bg-gray-50"}`}
                >
                  <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} alt="" loading="lazy" className="aspect-video w-20 shrink-0 rounded-lg object-cover sm:w-24" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold leading-snug text-gray-900 sm:text-base">{snippet.title}</span>
                    <span className="mt-1 block text-xs text-gray-500 sm:text-sm">{formatDuration(snippet.durationMs)}{snippet.speaker ? ` · ${snippet.speaker}` : ""}</span>
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-xl text-green-800">{expanded ? "−" : "+"}</span>
                </button>
              </h3>
              <div id={panelId} role="region" aria-labelledby={headingId} hidden={!expanded}>
                {expanded && <SnippetDetails snippet={snippet} videoId={videoId} />}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
