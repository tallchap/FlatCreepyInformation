
"use client";

import { useEffect, useRef, useState } from "react";

type Line = { start: number; text: string };
type Props = { videoId: string; height?: number };

export default function TranscriptPane({ videoId, height = 400 }: Props) {
  const [lines, setLines]   = useState<Line[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const containerRef        = useRef<HTMLDivElement>(null);
  const playerRef           = useRef<any>(null);   // YT.Player once ready

  /* 1 ▸ fetch transcript JSON */
  useEffect(() => {
    fetch(`/api/transcript/${videoId}`)
      .then((r) => r.json())
      .then(setLines)
      .catch(console.error);
  }, [videoId]);

  /* 2 ▸ load IFrame API & create a Player for the existing iframe */
  useEffect(() => {
    // helper that runs once API is loaded
    const mountPlayer = () => {
      if (playerRef.current) return; // already done
      const el = document.getElementById(`player-${videoId}`);
      if (el && (window as any).YT?.Player) {
        playerRef.current = new (window as any).YT.Player(el);
      }
    };

    // if API already there → mount immediately
    if ((window as any).YT?.Player) {
      mountPlayer();
    } else {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
      (window as any).onYouTubeIframeAPIReady = mountPlayer;
    }
  }, [videoId]);

  /* 3 ▸ timer to keep highlight in sync — scroll ONLY the inner pane */
  useEffect(() => {
    if (!playerRef.current) return;

    const container = containerRef.current!;
    const tick = () => {
      const t = playerRef.current.getCurrentTime?.() ?? 0;

      // find last line whose start ≤ t
      const idx = lines.findIndex(
        (l, i) => l.start <= t && (i + 1 === lines.length || lines[i + 1].start > t)
      );
      if (idx === active) return;      // nothing changed

      setActive(idx);

      // optional auto-scroll *inside* the pane:
      if (idx >= 0 && container) {
        const el = container.children[idx] as HTMLElement;
        const top = el.offsetTop;
        const bottom = top + el.offsetHeight;
        const visibleTop = container.scrollTop;
        const visibleBottom = visibleTop + container.clientHeight;

        // scroll only if the line is outside the visible region
        if (top < visibleTop || bottom > visibleBottom) {
          const center = top - container.clientHeight / 2 + el.offsetHeight / 2;
          container.scrollTo({ top: center, behavior: "smooth" });
        }
      }
    };

    // run 4×/sec
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [lines, active]);

  /* 4 ▸ render */
  return (
    <div
      ref={containerRef}
      className="overflow-y-auto text-[15px] leading-6 bg-white dark:bg-gray-800 rounded-xl shadow-md p-4 mb-6"
      style={{ maxHeight: height }}
    >
      {lines.map((l, i) => (
        <span
          key={i}
          onClick={() => {
            const p = playerRef.current;
            if (p?.seekTo) p.seekTo(l.start, true);
          }}
          className={`cursor-pointer mr-1 ${
            i === active ? "bg-blue-200 dark:bg-blue-700" : ""
          }`}
        >
          {l.text}
        </span>
      ))}
    </div>
  );
}
