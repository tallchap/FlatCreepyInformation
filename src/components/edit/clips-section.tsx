"use client";

import { useEffect, useState, useRef } from "react";

const DESC_LIMIT = 220;
function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf(" ", limit);
  const truncated = text.slice(0, cut > 0 ? cut : limit).replace(/[,;:\-–—'")\]}\s]+$/, "");
  return truncated + "...";
}
import type { AutoSnippet } from "@/lib/types/clip";
import { ClipPlayer } from "@/components/clips/clip-player";
import { ClipsStrip } from "@/components/clips/clips-strip";

export function ClipsSection({ videoId }: { videoId: string }) {
  const [snippets, setSnippets] = useState<AutoSnippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);
  const [descExpanded, setDescExpanded] = useState(false);
  const [activeSnippet, setActiveSnippet] = useState<AutoSnippet | null>(null);
  const [playerHeight, setPlayerHeight] = useState<number>(0);
  const playerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = playerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPlayerHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeSnippet]);

  useEffect(() => {
    setLoading(true);
    setSnippets([]);
    setActiveSnippet(null);
    fetch(`/api/snippets/auto?videoId=${videoId}`)
      .then((r) => r.json())
      .then((data: AutoSnippet[]) => {
        setSnippets(data);
        setActiveSnippet(data[0] ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [videoId]);


  if (loading || snippets.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="text-2xl font-bold text-gray-900">Ready-Made Snippets</h2>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2.5 w-full px-5 py-3 text-left hover:bg-gray-50 transition-colors"
        >
          <span
            className={`text-xs text-gray-400 transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          >
            ▼
          </span>
          <span className="text-[13px] font-bold text-gray-700">Snippets</span>
          <span className="text-[11px] text-gray-400">
            {snippets.length} snippet{snippets.length !== 1 ? "s" : ""}
          </span>
        </button>

        {open && (
          <div className="px-5 pb-5">
            {activeSnippet && (
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                <div className="lg:col-span-3">
                  <div ref={playerRef}>
                    <ClipPlayer
                      gcsUrl={activeSnippet.gcsUrl}
                      durationMs={activeSnippet.durationMs}
                      videoId={videoId}
                    />
                  </div>
                  <h3 className="text-lg font-bold text-gray-900 mt-3">
                    {activeSnippet.title}
                  </h3>
                  {activeSnippet.description && (
                    <p className="text-sm text-gray-600 mt-1">
                      {descExpanded ? (
                        <>
                          {activeSnippet.description}{" "}
                          <button onClick={() => setDescExpanded(false)} className="text-blue-500 font-medium">Show less</button>
                        </>
                      ) : (
                        <>
                          {truncateAtWord(activeSnippet.description, DESC_LIMIT)}
                          {activeSnippet.description.length > DESC_LIMIT && (
                            <>
                              {" "}
                              <button onClick={() => setDescExpanded(true)} className="text-blue-500 font-medium">See more</button>
                            </>
                          )}
                        </>
                      )}
                    </p>
                  )}
                </div>
                <div className="lg:col-span-2 flex flex-col">
                  {/* Snippet Transcript Pane — shows this snippet's transcript only */}
                  <div
                    className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col max-h-[200px] lg:max-h-none lg:h-[var(--player-h)]"
                    style={playerHeight ? { "--player-h": `${playerHeight}px` } as React.CSSProperties : undefined}
                  >
                    <div className="px-4 py-3 border-b border-gray-100 shrink-0">
                      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                        Snippet Transcript
                      </span>
                    </div>
                    <div className="overflow-y-auto p-4">
                      {activeSnippet.transcript ? (
                        <p className="text-sm text-gray-700 leading-relaxed">
                          {activeSnippet.transcript.replace(/\n{2,}/g, "\n").trim()}
                        </p>
                      ) : (
                        <p className="text-sm text-gray-400 italic">
                          No transcript available for this snippet
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex-1" />
                  <div className="mt-3 flex justify-end">
                    <a
                      href={activeSnippet.gcsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      download
                      className="inline-flex items-center gap-2 bg-[#DC2626] hover:bg-[#B91C1C] text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Download Snippet
                    </a>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4">
              <ClipsStrip
                clips={snippets.map((s) => ({
                  clipId: s.snippetId,
                  videoId: s.originalVideoId,
                  title: s.title,
                  category: s.category,
                  durationMs: s.durationMs,
                  viralScore: null,
                  viralReason: s.description,
                  transcript: s.transcript,
                  speaker: s.speaker,
                  gcsUrl: s.gcsUrl,
                  vizardEditorUrl: null,
                  persona: null,
                }))}
                videoId={videoId}
                activeClipId={activeSnippet?.snippetId ?? null}
                onSelectClip={(clip) => {
                  const match = snippets.find((s) => s.snippetId === clip.clipId);
                  if (match) { setActiveSnippet(match); setDescExpanded(false); }
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
