
"use client";

import { useEffect, useRef, useState } from "react";

type Line = { start: number; text: string };
type Props = { videoId: string; height?: number };

export default function TranscriptPane({ videoId, height = 400 }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef   = useRef<any>();        // YT player instance

  /* 1 Load transcript JSON */
  useEffect(() => {
    fetch(`/api/transcript/${videoId}`)
      .then(r => r.json())
      .then(setLines)
      .catch(console.error);
  }, [videoId]);

  /* 2 Load YouTube IFrame API & create player */
  useEffect(() => {
    if (playerRef.current) return;          // already loaded

    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(tag);

    // The API calls window.onYouTubeIframeAPIReady()
    (window as any).onYouTubeIframeAPIReady = () => {
      playerRef.current = new (window as any).YT.Player(`player-${videoId}`);
    };
  }, [videoId]);

  /* 3 Highlight timer */
  useEffect(() => {
    if (!playerRef.current) return;
    const id = setInterval(() => {
      const t = playerRef.current.getCurrentTime?.() ?? 0;
      // find last line whose start ≤ t
      const idx = lines.findIndex((l, i) => l.start <= t && (i + 1 === lines.length || lines[i + 1].start > t));
      setActive(idx >= 0 ? idx : null);
      if (idx >= 0 && containerRef.current) {
        const el = containerRef.current.children[idx] as HTMLElement;
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 200);
    return () => clearInterval(id);
  }, [lines]);

  /* 4 Render */
  return (
    <div
      ref={containerRef}
      className="overflow-y-auto text-[15px] leading-6 bg-white dark:bg-gray-800 rounded-xl shadow-md p-4 mb-6"
      style={{ maxHeight: height }}
    >
      {lines.map((l, i) => (
        <span
          key={i}
          onClick={() => playerRef.current?.seekTo(l.start, true)}
          className={`cursor-pointer mr-1 ${i === active ? "bg-blue-200 dark:bg-blue-700" : ""}`}
        >
          {l.text}
        </span>
      ))}
    </div>
  );
}
