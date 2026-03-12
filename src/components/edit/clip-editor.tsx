"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Timeline } from "./timeline";
import { TranscriptPanel } from "./transcript-panel";
import { DownloadHistory, type DownloadRecord } from "./download-history";

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
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const MAX_CLIP_SEC = 11 * 60;

export function ClipEditor() {
  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(60);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [quality, setQuality] = useState<Quality>("720p");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [history, setHistory] = useState<DownloadRecord[]>([]);
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

  // Load history from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("clip-history");
      if (saved) setHistory(JSON.parse(saved));
    } catch {}
  }, []);

  const saveHistory = (records: DownloadRecord[]) => {
    setHistory(records);
    localStorage.setItem("clip-history", JSON.stringify(records));
  };

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

  // Playhead sync — update position from player every 250ms
  useEffect(() => {
    if (!videoId) return;
    playheadTimerRef.current = setInterval(() => {
      if (!playerReadyRef.current) return;
      const t = playerRef.current?.getCurrentTime?.();
      if (t != null) setPlayheadSec(t);
    }, 250);
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
      // YT.PlayerState.PLAYING === 1
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
    if (id) {
      setVideoId(id);
      setExportError(null);
    }
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

  // Shared play-with-auto-pause logic
  const playAndPauseAt = (fromSec: number) => {
    if (!playerReadyRef.current) return;
    playerRef.current?.seekTo(fromSec, true);
    playerRef.current?.playVideo();
    if (previewTimerRef.current) clearInterval(previewTimerRef.current);
    previewTimerRef.current = setInterval(() => {
      const t = playerRef.current?.getCurrentTime?.();
      if (t != null && t >= endSec) {
        playerRef.current?.pauseVideo();
        if (previewTimerRef.current) clearInterval(previewTimerRef.current);
      }
    }, 250);
  };

  const handleFromStart = () => playAndPauseAt(startSec);

  const handlePlay = () => {
    if (!playerReadyRef.current) return;
    playerRef.current?.playVideo();
    // Still auto-pause at end
    if (previewTimerRef.current) clearInterval(previewTimerRef.current);
    previewTimerRef.current = setInterval(() => {
      const t = playerRef.current?.getCurrentTime?.();
      if (t != null && t >= endSec) {
        playerRef.current?.pauseVideo();
        if (previewTimerRef.current) clearInterval(previewTimerRef.current);
      }
    }, 250);
  };

  const handleLast5 = () => playAndPauseAt(Math.max(startSec, endSec - 5));

  const handleTranscriptClick = (sec: number) => {
    const mid = (startSec + endSec) / 2;
    if (sec < mid) {
      setStartSec(Math.min(sec, endSec - 1));
    } else {
      setEndSec(Math.max(sec, startSec + 1));
    }
    if (playerReadyRef.current) playerRef.current?.seekTo(sec, true);
  };

  const handleExport = async () => {
    if (!videoId || clipTooLong) return;
    setExporting(true);
    setExportError(null);

    try {
      const resp = await fetch("/api/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `https://www.youtube.com/watch?v=${videoId}`,
          startSec,
          endSec,
          quality,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Export failed" }));
        throw new Error(err.error || "Export failed");
      }

      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `clip-${videoId}-${startSec}-${endSec}.mp4`;
      a.click();
      URL.revokeObjectURL(a.href);

      const title = playerRef.current?.getVideoData?.()?.title || videoId;
      const record: DownloadRecord = {
        id: crypto.randomUUID(),
        videoId,
        title,
        startSec,
        endSec,
        quality,
        date: new Date().toISOString(),
      };
      saveHistory([record, ...history]);
    } catch (err: any) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
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
              if (id) { setVideoId(id); setExportError(null); }
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
                <TimeInput value={startSec} onChange={(s) => setStartSec(Math.min(s, endSec - 1))} />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 uppercase">End</label>
                <TimeInput value={endSec} onChange={(s) => setEndSec(Math.max(s, startSec + 1))} />
              </div>

              <div className="text-sm text-gray-500">
                Clip: <span className="font-semibold text-gray-700">{formatDuration(clipDuration)}</span>
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
                onClick={handlePlay}
                className={btnClass}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = DINO_RED_HOVER)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                Play
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

            {exportError && (
              <p className="mt-3 text-sm text-red-600">{exportError}</p>
            )}
          </div>

          {/* Download History */}
          {history.length > 0 && (
            <DownloadHistory records={history} onClear={() => saveHistory([])} />
          )}
        </>
      )}
    </div>
  );
}

/* ── Editable MM:SS input ── */

function TimeInput({ value, onChange }: { value: number; onChange: (sec: number) => void }) {
  const [text, setText] = useState(formatDuration(value));
  const prevValue = useRef(value);

  useEffect(() => {
    if (value !== prevValue.current) {
      setText(formatDuration(value));
      prevValue.current = value;
    }
  }, [value]);

  const commit = () => {
    const match = text.match(/^(\d+):(\d{1,2})$/);
    if (match) {
      const sec = parseInt(match[1]) * 60 + parseInt(match[2]);
      onChange(sec);
      prevValue.current = sec;
    } else {
      setText(formatDuration(value));
    }
  };

  return (
    <input
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="w-16 text-center rounded border border-gray-300 px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-400"
    />
  );
}
