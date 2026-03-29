"use client";

import { useEffect, useState, useRef } from "react";
import type { Clip } from "@/lib/types/clip";
import { ClipPlayer } from "@/components/clips/clip-player";
import { ClipsStrip } from "@/components/clips/clips-strip";
import { TranscriptPanel } from "./transcript-panel";

function filterDisplayClips(clips: Clip[]): Clip[] {
  const safety = clips.filter((c) => c.category === "ai_safety");
  const viral = clips
    .filter((c) => c.category === "viral")
    .sort((a, b) => (b.viralScore ?? 0) - (a.viralScore ?? 0));
  const topViral = viral[0];
  const result = [...safety];
  if (topViral && (topViral.viralScore ?? 0) >= 9) {
    result.unshift(topViral);
  }
  return result;
}

export function ClipsSection({ videoId }: { videoId: string }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);
  const [activeClip, setActiveClip] = useState<Clip | null>(null);
  const [playerHeight, setPlayerHeight] = useState<number | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setClips([]);
    setActiveClip(null);
    fetch(`/api/clips/video?videoId=${videoId}`)
      .then((r) => r.json())
      .then((data: Clip[]) => {
        const display = filterDisplayClips(data);
        setClips(display);
        setActiveClip(display[0] ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [videoId]);

  // Match transcript height to clip player
  useEffect(() => {
    const el = playerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setPlayerHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeClip, open]);

  // Don't render anything if no clips
  if (loading || clips.length === 0) return null;

  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Ready-Made Snippets</h2>
        <p className="text-sm text-gray-500 mt-1">
          Snippets from this episode, ready to share
        </p>
      </div>
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Collapsible toggle */}
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
        <span className="text-[13px] font-bold text-gray-700">Clips</span>
        <span className="text-[11px] text-gray-400">
          {clips.length} clip{clips.length !== 1 ? "s" : ""}
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5">
          {/* Video + Transcript grid (matches editor layout) */}
          {activeClip && (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3">
                <div ref={playerRef}>
                  <ClipPlayer
                    gcsUrl={activeClip.gcsUrl}
                    durationMs={activeClip.durationMs}
                    videoId={videoId}
                  />
                </div>
                {/* Title + description under video */}
                <h3 className="text-lg font-bold text-gray-900 mt-3">
                  {activeClip.title}
                </h3>
                {activeClip.viralReason && (
                  <p className="text-sm text-gray-600 mt-1">
                    {activeClip.viralReason}
                  </p>
                )}
              </div>
              <div className="lg:col-span-2">
                <div style={playerHeight ? { height: playerHeight } : undefined}>
                  <TranscriptPanel
                    videoId={videoId}
                    startSec={0}
                    endSec={activeClip.durationMs / 1000}
                    onLineClick={() => {}}
                  />
                </div>
                {/* Download button under transcript, right-aligned */}
                <div className="mt-3 flex justify-end">
                  <a
                    href={activeClip.gcsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    download
                    className="inline-flex items-center gap-2 border border-[#DC2626] text-[#DC2626] hover:bg-red-50 text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Download Snippet
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Carousel strip */}
          <div className="mt-4">
            <ClipsStrip
              clips={clips}
              videoId={videoId}
              activeClipId={activeClip?.clipId ?? null}
              onSelectClip={(clip) => setActiveClip(clip)}
            />
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
