"use client";

import type { Clip } from "@/lib/types/clip";
import Image from "next/image";

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
        {/* Dark overlay + snippysaurus logo */}
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
          <Image
            src="/snippysaurus-logo.png"
            alt=""
            width={28}
            height={28}
            className="rounded"
          />
        </div>
        <span className="absolute bottom-1.5 right-1.5 bg-black/75 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded z-10">
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

export function ClipsStrip({
  clips,
  videoId,
  activeClipId,
  onSelectClip,
}: {
  clips: Clip[];
  videoId: string;
  activeClipId: string | null;
  onSelectClip: (clip: Clip) => void;
}) {
  if (clips.length === 0) return null;

  return (
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
    </div>
  );
}
