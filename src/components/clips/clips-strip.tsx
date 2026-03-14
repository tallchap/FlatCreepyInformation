"use client";

import type { Clip } from "@/lib/types/clip";

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function ClipCard({
  clip,
  videoId,
  active,
  onClick,
}: {
  clip: Clip;
  videoId: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 w-[200px] rounded-lg overflow-hidden border bg-white text-left transition-all cursor-pointer ${
        active
          ? "border-blue-500 ring-2 ring-blue-200 shadow-md"
          : "border-gray-200 hover:border-blue-300 hover:shadow-md"
      }`}
    >
      <div className="relative aspect-video bg-black">
        <img
          src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
          alt=""
          className="w-full h-full object-cover"
        />
        {/* Play overlay */}
        {!active && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <div className="w-8 h-8 bg-black/60 rounded-full flex items-center justify-center">
              <svg
                className="w-3.5 h-3.5 text-white ml-0.5"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <polygon points="8,5 20,12 8,19" />
              </svg>
            </div>
          </div>
        )}
        <span className="absolute bottom-1.5 right-1.5 bg-black/75 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded">
          {formatDuration(clip.durationMs)}
        </span>
      </div>
      <div className="p-2">
        <p className="text-[11px] font-medium text-gray-800 line-clamp-2 leading-snug">
          {clip.title}
        </p>
        {active && (
          <p className="text-[10px] text-blue-600 font-semibold mt-0.5">
            Playing
          </p>
        )}
      </div>
    </button>
  );
}

function FullVideoCard({
  videoId,
  videoLength,
  onClick,
}: {
  videoId: string;
  videoLength: string | null;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 w-[200px] rounded-lg overflow-hidden border border-gray-200 bg-white text-left transition-all cursor-pointer hover:border-blue-300 hover:shadow-md"
    >
      <div className="relative aspect-video bg-black">
        <img
          src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
          alt=""
          className="w-full h-full object-cover opacity-70"
        />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <svg
            className="w-5 h-5 text-white"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <polygon points="8,5 20,12 8,19" />
          </svg>
          <span className="text-[9px] font-semibold text-white uppercase tracking-wide bg-black/50 px-2 py-0.5 rounded">
            Full Video
          </span>
        </div>
      </div>
      <div className="p-2">
        <p className="text-[10px] font-semibold text-gray-700">
          Full Episode{videoLength ? ` · ${videoLength}` : ""}
        </p>
        <p className="text-[9px] text-gray-400">Return to main video</p>
      </div>
    </button>
  );
}

export function ClipsStrip({
  clips,
  videoId,
  videoLength,
  activeClipId,
  onSelectClip,
  onSelectFullVideo,
}: {
  clips: Clip[];
  videoId: string;
  videoLength: string | null;
  activeClipId: string | null;
  onSelectClip: (clip: Clip) => void;
  onSelectFullVideo: () => void;
}) {
  if (clips.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-gray-800">Viral Clips</h3>
        <span className="text-xs text-gray-400">
          {clips.length} clip{clips.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 scroll-smooth snap-x snap-mandatory">
        {clips.map((clip) => (
          <ClipCard
            key={clip.clipId}
            clip={clip}
            videoId={videoId}
            active={activeClipId === clip.clipId}
            onClick={() => onSelectClip(clip)}
          />
        ))}
        {activeClipId && (
          <FullVideoCard
            videoId={videoId}
            videoLength={videoLength}
            onClick={onSelectFullVideo}
          />
        )}
      </div>
    </div>
  );
}
