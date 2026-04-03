"use client";


const DESC_LIMIT = 100;
function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf(" ", limit);
  const truncated = text.slice(0, cut > 0 ? cut : limit).replace(/[,;:\-–—'")\]}\s]+$/, "");
  return truncated + "...";
}
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
    <div
      className={`flex-shrink-0 w-[320px] rounded-lg overflow-hidden bg-white text-left cursor-pointer border-[6px] ${
        active
          ? "border-[#99cc66]"
          : "border-transparent hover:border-gray-200"
      }`}
    >
      <div onClick={onClick}>
        <div className="relative aspect-video bg-black">
          <img
            src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
            alt=""
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <Image
              src="/snippysaurus-logo.png"
              alt=""
              width={48}
              height={48}
              className="rounded"
            />
          </div>
          <span className="absolute bottom-1.5 right-1.5 bg-black/75 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded z-10">
            {formatDuration(clip.durationMs)}
          </span>
        </div>
        <div className="p-2">
          <p className="text-sm font-medium text-gray-800 line-clamp-2 leading-snug">
            {clip.title}
          </p>
        </div>
      </div>
      <div className="px-2 pb-2">
        <p className="text-[10px] text-gray-500 mt-0.5">
          {clip.viralReason ? truncateAtWord(clip.viralReason, DESC_LIMIT) : "\u00A0"}
        </p>
      </div>
    </div>
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
    <div className="flex gap-3 overflow-x-auto pb-2">
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
