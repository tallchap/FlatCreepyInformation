"use client";

import { useRef, useState } from "react";

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function ClipPlayer({
  gcsUrl,
  durationMs,
  videoId,
}: {
  gcsUrl: string;
  durationMs: number;
  videoId: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasStarted, setHasStarted] = useState(false);

  return (
    <div className="relative w-full aspect-video bg-black rounded-xl shadow-lg overflow-hidden border-2 border-blue-500">
      <video
        ref={videoRef}
        src={gcsUrl}
        controls
        poster={`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`}
        className="w-full h-full object-contain"
        onPlay={() => setHasStarted(true)}
      />
      {/* Clip label overlay */}
      <div className="absolute top-3 left-3 bg-red-500/90 text-white text-[10px] font-bold px-2.5 py-1 rounded-md uppercase tracking-wide pointer-events-none">
        Clip · {formatDuration(durationMs)}
      </div>
    </div>
  );
}
