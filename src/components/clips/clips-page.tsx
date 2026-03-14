"use client";

import { useState } from "react";
import Link from "next/link";
import type { Clip } from "@/lib/types/clip";
import { ClipPlayer } from "./clip-player";
import { ClipsStrip } from "./clips-strip";
import TranscriptPane from "@/components/TranscriptPane";

type VideoMeta = {
  title: string;
  channel: string;
  published: string;
  videoLength: string | null;
  speakers: string | null;
};

function filterDisplayClips(clips: Clip[]): Clip[] {
  // Keep all ai_safety clips
  const safety = clips.filter((c) => c.category === "ai_safety");
  // Keep only the single highest-scoring viral clip (must be >= 9)
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

export function ClipsPage({
  videoId,
  videoMeta,
  clips,
}: {
  videoId: string;
  videoMeta: VideoMeta;
  clips: Clip[];
}) {
  const displayClips = filterDisplayClips(clips);
  const [activeClip, setActiveClip] = useState<Clip | null>(
    displayClips[0] ?? null,
  );
  const [episodeOpen, setEpisodeOpen] = useState(true);
  const [episodeTranscriptOpen, setEpisodeTranscriptOpen] = useState(true);
  const [clipTranscriptOpen, setClipTranscriptOpen] = useState(true);

  return (
    <div className="space-y-3 max-w-4xl">
      {/* Title */}
      <h1 className="text-lg font-bold text-gray-900">{videoMeta.title}</h1>

      {/* Compact metadata */}
      <div className="flex flex-wrap gap-3 text-xs text-gray-500">
        <span className="font-medium text-gray-700">{videoMeta.channel}</span>
        <span>{videoMeta.published}</span>
        {videoMeta.videoLength && <span>{videoMeta.videoLength}</span>}
        {videoMeta.speakers && <span>{videoMeta.speakers}</span>}
      </div>

      {/* ═══ Full Episode Section (collapsible) ═══ */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <button
          onClick={() => setEpisodeOpen(!episodeOpen)}
          className="flex items-center gap-2.5 w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors"
        >
          <span
            className={`text-xs text-gray-400 transition-transform ${
              episodeOpen ? "" : "-rotate-90"
            }`}
          >
            ▼
          </span>
          <span className="text-[13px] font-bold text-gray-700">
            Full Episode
          </span>
          {videoMeta.videoLength && (
            <span className="text-[11px] text-gray-400">
              {videoMeta.videoLength}
            </span>
          )}
          {episodeOpen && (
            <Link
              href={`/vizard/${videoId}`}
              onClick={(e) => e.stopPropagation()}
              className="ml-auto bg-[#DC2626] hover:bg-[#B91C1C] text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors"
            >
              Snip It ✂️
            </Link>
          )}
        </button>

        {episodeOpen && (
          <div className="px-4 pb-4">
            <div className="w-full aspect-video rounded-xl shadow-lg overflow-hidden">
              <iframe
                id={`player-${videoId}`}
                className="w-full h-full"
                src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1`}
                title={videoMeta.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>

            {/* Episode transcript toggle */}
            <button
              onClick={() => setEpisodeTranscriptOpen(!episodeTranscriptOpen)}
              className="flex items-center gap-2 mt-3 pt-2 border-t border-gray-100 w-full text-left"
            >
              <span
                className={`text-[10px] text-gray-400 transition-transform ${
                  episodeTranscriptOpen ? "" : "-rotate-90"
                }`}
              >
                ▼
              </span>
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                Transcript
              </span>
            </button>
            {episodeTranscriptOpen && (
              <TranscriptPane
                videoId={videoId}
                height={100}
                playerSyncKey="full"
              />
            )}
          </div>
        )}
      </div>

      {/* ═══ Clips Section ═══ */}
      <div
        className={`bg-white border rounded-xl overflow-hidden ${
          activeClip ? "border-blue-200" : "border-gray-200"
        }`}
      >
        <div
          className={`px-4 py-3 ${activeClip ? "bg-blue-50" : ""}`}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-bold text-gray-700">
              Clips
            </span>
            {!activeClip && (
              <span className="text-[11px] text-gray-400">
                {displayClips.length} clip
                {displayClips.length !== 1 ? "s" : ""}
              </span>
            )}
            {activeClip && episodeOpen && (
              <a
                href={activeClip.gcsUrl}
                download
                className="ml-auto bg-[#DC2626] hover:bg-[#B91C1C] text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors"
              >
                Download ↓
              </a>
            )}
          </div>
          {activeClip && (
            <h3 className="text-base font-bold text-gray-900 mt-1">
              {activeClip.title}
            </h3>
          )}
        </div>

        <div className="px-4 pb-4">
          {/* Clip player or placeholder */}
          {activeClip ? (
            <ClipPlayer
              gcsUrl={activeClip.gcsUrl}
              durationMs={activeClip.durationMs}
              videoId={videoId}
            />
          ) : (
            <div className="w-full aspect-video bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl flex items-center justify-center text-sm text-gray-400">
              Select a clip to play
            </div>
          )}

          {/* Clip transcript toggle */}
          {activeClip && (
            <>
              <button
                onClick={() => setClipTranscriptOpen(!clipTranscriptOpen)}
                className="flex items-center gap-2 mt-3 pt-2 border-t border-gray-100 w-full text-left"
              >
                <span
                  className={`text-[10px] text-gray-400 transition-transform ${
                    clipTranscriptOpen ? "" : "-rotate-90"
                  }`}
                >
                  ▼
                </span>
                <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Clip Transcript
                </span>
              </button>
              {clipTranscriptOpen && activeClip.transcript && (
                <div className="mt-2 text-sm text-gray-600 leading-relaxed max-h-[80px] overflow-y-auto">
                  {activeClip.transcript}
                </div>
              )}
            </>
          )}

          {/* Clips carousel */}
          <div className="mt-3">
            <ClipsStrip
              clips={displayClips}
              videoId={videoId}
              activeClipId={activeClip?.clipId ?? null}
              onSelectClip={(clip) => setActiveClip(clip)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
