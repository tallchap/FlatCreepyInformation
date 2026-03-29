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
        {activeClip && open && (
          <a
            href={activeClip.gcsUrl}
            target="_blank"
            rel="noopener noreferrer"
            download
            onClick={(e) => e.stopPropagation()}
            className="ml-auto bg-[#DC2626] hover:bg-[#B91C1C] text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors"
          >
            Download ↓
          </a>
        )}
      </button>

      {open && (
        <div className="px-5 pb-5">
          {/* Active clip info */}
          {activeClip && (
            <>
              <h3 className="text-xl font-bold text-gray-900 mt-1">
                {activeClip.title}
              </h3>
              {activeClip.viralReason && (
                <p className="text-sm text-gray-600 mt-1 mb-3">
                  {activeClip.viralReason}
                </p>
              )}
            </>
          )}

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
              </div>
              <div
                className="lg:col-span-2"
                style={playerHeight ? { height: playerHeight } : undefined}
              >
                <TranscriptPanel
                  videoId={videoId}
                  startSec={0}
                  endSec={activeClip.durationMs / 1000}
                  onLineClick={() => {}}
                />
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
