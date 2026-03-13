"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Timeline } from "./timeline";
import { TranscriptPanel } from "./transcript-panel";
import { useDownload } from "@/lib/download-context";

type Quality = "720p" | "1080p";

const DINO_RED = "#DC2626";
const DINO_RED_HOVER = "#B91C1C";

function extractVideoId(input: string): string | null {
  if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) return input.trim();
  const match = input.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([A-Za-z0-9_-]{11})/,
  );
  return match ? match[1] : null;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

const MAX_CLIP_SEC = 11 * 60;
const FRAME_STEP = 2 / 30; // 2 frames at 30fps ≈ 0.067s

export function ClipEditor() {
  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(60);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [quality, setQuality] = useState<Quality>("720p");
  const { startDownload, hasActive: exporting } = useDownload();
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<any[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);
  const playerRef = useRef<any>(null);
  const playerReadyRef = useRef(false);
  const previewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playheadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-load from ?v= query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("v");
    if (v) {
      setUrl(v);
      const id = extractVideoId(v);
      if (id) setVideoId(id);
    }
  }, []);

  // Load YouTube IFrame API
  useEffect(() => {
    if ((window as any).YT?.Player) return;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(s);
  }, []);

  // Mount player when videoId changes
  useEffect(() => {
    if (!videoId) return;
    playerReadyRef.current = false;

    const mount = () => {
      const container = document.getElementById("clip-player");
      if (!container) return;
      container.innerHTML = "";
      playerRef.current = new (window as any).YT.Player(container, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          onReady: (e: any) => {
            playerReadyRef.current = true;
            const dur = e.target.getDuration();
            setDuration(dur);
            setStartSec(0);
            setEndSec(Math.min(dur, 60));
            setPlayheadSec(0);
          },
        },
      });
    };

    if ((window as any).YT?.Player) {
      mount();
    } else {
      (window as any).onYouTubeIframeAPIReady = mount;
    }

    return () => {
      if (previewTimerRef.current) clearInterval(previewTimerRef.current);
      if (playheadTimerRef.current) clearInterval(playheadTimerRef.current);
      if (playerRef.current?.destroy) {
        try { playerRef.current.destroy(); } catch {}
      }
      playerRef.current = null;
    };
  }, [videoId]);

  // Playhead sync + isPlaying state — update from player every 100ms
  useEffect(() => {
    if (!videoId) return;
    playheadTimerRef.current = setInterval(() => {
      if (!playerReadyRef.current) return;
      const t = playerRef.current?.getCurrentTime?.();
      if (t != null) setPlayheadSec(t);
      const state = playerRef.current?.getPlayerState?.();
      setIsPlaying(state === 1);
    }, 100);
    return () => {
      if (playheadTimerRef.current) clearInterval(playheadTimerRef.current);
    };
  }, [videoId]);

  // Spacebar play/pause
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      e.preventDefault();
      if (!playerReadyRef.current) return;
      const state = playerRef.current?.getPlayerState?.();
      if (state === 1) {
        playerRef.current?.pauseVideo();
      } else {
        playerRef.current?.playVideo();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const handleLoad = () => {
    const id = extractVideoId(url);
    if (id) setVideoId(id);
  };

  const clipDuration = endSec - startSec;
  const clipTooLong = clipDuration > MAX_CLIP_SEC;

  const handleStartChange = useCallback(
    (sec: number) => {
      setStartSec(sec);
      if (playerReadyRef.current) playerRef.current?.seekTo(sec, true);
    },
    [],
  );

  const handleEndChange = useCallback(
    (sec: number) => setEndSec(sec),
    [],
  );

  const handleSeek = useCallback(
    (sec: number) => {
      setPlayheadSec(sec);
      if (playerReadyRef.current) playerRef.current?.seekTo(sec, true);
    },
    [],
  );

  // Auto-pause at endSec helper
  const startAutoPause = () => {
    if (previewTimerRef.current) clearInterval(previewTimerRef.current);
    previewTimerRef.current = setInterval(() => {
      const t = playerRef.current?.getCurrentTime?.();
      if (t != null && t >= endSec) {
        playerRef.current?.pauseVideo();
        if (previewTimerRef.current) clearInterval(previewTimerRef.current);
      }
    }, 100);
  };

  const handleFromStart = () => {
    if (!playerReadyRef.current) return;
    playerRef.current?.seekTo(startSec, true);
    playerRef.current?.playVideo();
    startAutoPause();
  };

  const handlePlayPause = () => {
    if (!playerReadyRef.current) return;
    if (isPlaying) {
      playerRef.current?.pauseVideo();
      if (previewTimerRef.current) clearInterval(previewTimerRef.current);
    } else {
      playerRef.current?.playVideo();
      startAutoPause();
    }
  };

  const handleLast5 = () => {
    if (!playerReadyRef.current) return;
    playerRef.current?.seekTo(Math.max(startSec, endSec - 5), true);
    playerRef.current?.playVideo();
    startAutoPause();
  };

  const handleTranscriptClick = (sec: number) => {
    const mid = (startSec + endSec) / 2;
    if (sec < mid) {
      setStartSec(Math.min(sec, endSec - 0.01));
    } else {
      setEndSec(Math.max(sec, startSec + 0.01));
    }
    if (playerReadyRef.current) playerRef.current?.seekTo(sec, true);
  };

  const loadDebugLogs = useCallback(async () => {
    setDebugLoading(true);
    try {
      const resp = await fetch("/api/download-debug", { cache: "no-store" });
      const data = await resp.json();
      setDebugLogs(Array.isArray(data.items) ? data.items : []);
    } finally {
      setDebugLoading(false);
    }
  }, []);

  const handleExport = () => {
    if (!videoId || clipTooLong) return;
    const title = playerRef.current?.getVideoData?.()?.title || videoId;
    startDownload({ videoId, title, startSec, endSec, quality });
  };

  const btnClass = `px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Clip Editor</h1>
        <p className="text-sm text-gray-500 mt-1">
          Trim and export YouTube video clips (max {MAX_CLIP_SEC / 60} min) &middot; Spacebar to play/pause
        </p>
      </div>

      {/* URL Input */}
      <div>
        <input
          type="text"
          placeholder="Paste YouTube URL or video ID and press Enter..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLoad()}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (extractVideoId(pasted)) {
              e.preventDefault();
              setUrl(pasted);
              const id = extractVideoId(pasted);
              if (id) setVideoId(id);
            }
          }}
          className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
        />
      </div>

      {videoId && (
        <>
          {/* Player + Transcript side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-3">
              <div className="aspect-video bg-black rounded-xl overflow-hidden">
                <div id="clip-player" className="w-full h-full" />
              </div>
            </div>
            <div className="lg:col-span-2">
              <TranscriptPanel
                videoId={videoId}
                startSec={startSec}
                endSec={endSec}
                onLineClick={handleTranscriptClick}
              />
            </div>
          </div>

          {/* Timeline */}
          <Timeline
            duration={duration}
            startSec={startSec}
            endSec={endSec}
            playheadSec={playheadSec}
            onStartChange={handleStartChange}
            onEndChange={handleEndChange}
            onSeek={handleSeek}
          />

          {/* Controls */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              {/* Time inputs */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 uppercase">Start</label>
                <TimeInput value={startSec} onChange={(s) => setStartSec(Math.min(s, endSec - 0.01))} />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 uppercase">End</label>
                <TimeInput value={endSec} onChange={(s) => setEndSec(Math.max(s, startSec + 0.01))} />
              </div>

              <div className="text-sm text-gray-500">
                Clip: <span className="font-semibold text-gray-700 font-mono">{formatDuration(clipDuration)}</span>
                {clipTooLong && (
                  <span className="text-red-500 ml-2">
                    (exceeds {MAX_CLIP_SEC / 60} min limit)
                  </span>
                )}
              </div>

              <div className="flex-1" />

              {/* Quality toggle */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                {(["720p", "1080p"] as Quality[]).map((q) => (
                  <button
                    key={q}
                    onClick={() => setQuality(q)}
                    className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                      quality === q
                        ? "text-white"
                        : "bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                    style={quality === q ? { backgroundColor: DINO_RED } : undefined}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            {/* Play buttons row */}
            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-gray-100">
              <button
                onClick={handleFromStart}
                className={btnClass}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = DINO_RED_HOVER)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                From Start
              </button>
              <button
                onClick={() => handleSeek(Math.max(0, playheadSec - FRAME_STEP))}
                className={btnClass}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = DINO_RED_HOVER)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                -2f
              </button>
              <button
                onClick={handlePlayPause}
                className={`${btnClass} min-w-[80px]`}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = DINO_RED_HOVER)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button
                onClick={() => handleSeek(Math.min(duration, playheadSec + FRAME_STEP))}
                className={btnClass}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = DINO_RED_HOVER)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                +2f
              </button>
              <button
                onClick={handleLast5}
                className={btnClass}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = DINO_RED_HOVER)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                Last 5s
              </button>

              <div className="flex-1" />

              <button
                onClick={() => { setDebugOpen((v) => !v); if (!debugOpen) void loadDebugLogs(); }}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                {debugOpen ? "Hide Debug" : "Show Debug"}
              </button>

              <button
                onClick={handleExport}
                disabled={exporting || clipTooLong}
                className={btnClass}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => { if (!exporting && !clipTooLong) e.currentTarget.style.backgroundColor = DINO_RED_HOVER; }}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                {exporting ? "Exporting..." : "Export MP4"}
              </button>
            </div>

          </div>

          {debugOpen && (
            <div className="bg-black text-green-300 rounded-xl p-4 text-xs font-mono overflow-auto max-h-[420px] space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-green-200">Download service debug log</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(debugLogs, null, 2));
                      setDebugCopied(true);
                      setTimeout(() => setDebugCopied(false), 1500);
                    }}
                    className="px-2 py-1 rounded border border-green-700 text-green-200 hover:bg-green-900/30"
                  >
                    {debugCopied ? "Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={() => void loadDebugLogs()}
                    className="px-2 py-1 rounded border border-green-700 text-green-200 hover:bg-green-900/30"
                  >
                    {debugLoading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
              </div>
              {debugLogs.length === 0 ? (
                <div className="text-green-500">No debug events yet.</div>
              ) : (
                debugLogs.slice().reverse().map((entry, idx) => (
                  <pre key={idx} className="whitespace-pre-wrap break-all border border-green-900 rounded p-3 bg-black/40">{JSON.stringify(entry, null, 2)}</pre>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Editable MM:SS.ms input ── */

function TimeInput({ value, onChange }: { value: number; onChange: (sec: number) => void }) {
  const [text, setText] = useState(formatDuration(value));
  const prevValue = useRef(value);

  useEffect(() => {
    if (Math.abs(value - prevValue.current) > 0.005) {
      setText(formatDuration(value));
      prevValue.current = value;
    }
  }, [value]);

  const commit = () => {
    // Accept M:SS, M:SS.mm, or just seconds
    const match = text.match(/^(\d+):(\d{1,2}(?:\.\d{0,2})?)$/);
    if (match) {
      const sec = parseInt(match[1]) * 60 + parseFloat(match[2]);
      onChange(sec);
      prevValue.current = sec;
      setText(formatDuration(sec));
    } else {
      const num = parseFloat(text);
      if (!isNaN(num) && num >= 0) {
        onChange(num);
        prevValue.current = num;
        setText(formatDuration(num));
      } else {
        setText(formatDuration(value));
      }
    }
  };

  return (
    <input
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="w-20 text-center rounded border border-gray-300 px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-400"
    />
  );
}
