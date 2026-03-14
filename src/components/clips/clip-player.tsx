"use client";

import { useRef, useState } from "react";
import Image from "next/image";

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
      {/* Snippysaurus logo overlay */}
      <div className="absolute inset-0 bg-black/65 flex items-center justify-center pointer-events-none">
        <Image
          src="/snippysaurus-logo.png"
          alt="Snippysaurus"
          width={64}
          height={64}
          className="rounded-[10px]"
        />
      </div>
      {/* Clip label overlay */}
      <div className="absolute top-3 left-3 bg-blue-600/90 text-white text-[10px] font-bold px-2.5 py-1 rounded-md uppercase tracking-wide pointer-events-none z-10">
        Clip · {formatDuration(durationMs)}
      </div>
    </div>
  );
}
