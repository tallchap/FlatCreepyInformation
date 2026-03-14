"use client";

import { useState } from "react";
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

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
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
  const [activeClip, setActiveClip] = useState<Clip | null>(null);

  return (
    <div className="space-y-3">
      {/* Now playing bar */}
      {activeClip && (
        <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-sm text-blue-800">
          <span className="font-semibold whitespace-nowrap">
            ▶ Now Playing Clip:
          </span>
          <span className="truncate flex-1">&ldquo;{activeClip.title}&rdquo;</span>
          <button
            onClick={() => setActiveClip(null)}
            className="text-blue-600 hover:text-blue-800 font-semibold whitespace-nowrap underline text-xs"
          >
            ← Back to Full Video
          </button>
        </div>
      )}

      {/* Title */}
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-lg font-bold text-gray-900">{videoMeta.title}</h1>
      </div>

      {/* Compact metadata */}
      <div className="flex flex-wrap gap-3 text-xs text-gray-500">
        <span className="font-medium text-gray-700">{videoMeta.channel}</span>
        <span>{videoMeta.published}</span>
        {videoMeta.videoLength && <span>{videoMeta.videoLength}</span>}
        {videoMeta.speakers && <span>{videoMeta.speakers}</span>}
      </div>

      {/* Main 2-column layout */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4">
        {/* Left column: Player + Clips */}
        <div className="space-y-3">
          {/* Player */}
          {activeClip ? (
            <ClipPlayer
              gcsUrl={activeClip.gcsUrl}
              durationMs={activeClip.durationMs}
              videoId={videoId}
            />
          ) : (
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
          )}

          {/* Clips strip */}
          <ClipsStrip
            clips={clips}
            videoId={videoId}
            videoLength={videoMeta.videoLength}
            activeClipId={activeClip?.clipId ?? null}
            onSelectClip={(clip) => setActiveClip(clip)}
            onSelectFullVideo={() => setActiveClip(null)}
          />
        </div>

        {/* Right column: Transcript */}
        <div className="xl:sticky xl:top-4 self-start">
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
            <div className="px-3 py-2 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Transcript
              </span>
              {activeClip && (
                <span className="text-[10px] font-semibold text-blue-600">
                  Clip segment
                </span>
              )}
            </div>
            <TranscriptPane
              videoId={videoId}
              height={500}
              playerSyncKey={activeClip?.clipId ?? "full"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
