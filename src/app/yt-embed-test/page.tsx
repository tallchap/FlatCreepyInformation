"use client";

// Gate C test bench for the yt-only editor: the clean YouTube embed on its own,
// with buttons for each state the gate screenshots (play, pause, seek, last 20 s).
// ?v=<id>&crop=<px>
import { useEffect, useRef, useState } from "react";
import { mountYouTubeCleanPlayer, YT_CROP_PX, type CleanPlayer } from "@/components/edit/youtube-clean-player";

export default function YtEmbedTestPage() {
  const boxRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<CleanPlayer | null>(null);
  const [state, setState] = useState(-1);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [shield, setShield] = useState(true);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [crop, setCrop] = useState(YT_CROP_PX);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setVideoId(p.get("v") || "anAmTGcewX8");
    const c = Number(p.get("crop"));
    if (Number.isFinite(c) && p.get("crop") !== null) setCrop(c);
  }, []);

  useEffect(() => {
    if (!videoId || !boxRef.current) return;
    const p = mountYouTubeCleanPlayer(boxRef.current, videoId, {
      crop,
      onReady: (pl) => { setDuration(pl.getDuration()); (window as any).__ytReady = true; },
      onStateChange: setState,
    });
    playerRef.current = p;
    (window as any).__yt = p;
    const off = p.onTime(setTime);
    return () => { off(); p.destroy(); };
  }, [videoId, crop]);

  const btn = "px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50";
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-4">
      <meta name="robots" content="noindex" />
      <h1 className="text-xl font-bold">YouTube clean-embed test (Gate C)</h1>
      <div ref={boxRef} data-testid="player-box" className="relative w-full aspect-video rounded-xl" />
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <button className={btn} data-testid="play" onClick={() => playerRef.current?.playVideo()}>Play</button>
        <button className={btn} data-testid="pause" onClick={() => playerRef.current?.pauseVideo()}>Pause</button>
        <button className={btn} data-testid="seek-mid" onClick={() => playerRef.current?.seekTo(duration / 2)}>Seek to middle</button>
        <button className={btn} data-testid="seek-end" onClick={() => { playerRef.current?.seekTo(Math.max(0, duration - 20)); playerRef.current?.playVideo(); }}>Last 20 s</button>
        <button className={btn} onClick={() => { const v = !shield; setShield(v); playerRef.current?.setShield(v); }}>
          Shield: {shield ? "on" : "off (YouTube gets clicks)"}
        </button>
        <span className="font-mono text-gray-600" data-testid="status">
          state {state} · {time.toFixed(1)} / {duration.toFixed(1)} s · crop {crop}px
        </span>
      </div>
    </div>
  );
}
