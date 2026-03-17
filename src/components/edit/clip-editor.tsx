"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Timeline } from "./timeline";
import { TranscriptPanel } from "./transcript-panel";
import { useDownload } from "@/lib/download-context";
import { OverlayEditorModal, type OverlaySettings } from "./overlay-editor-modal";

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
  const [gcsAvailable, setGcsAvailable] = useState<boolean | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<any[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);
  const [systemInfo, setSystemInfo] = useState<any>(null);
  const [renderInfo, setRenderInfo] = useState<any>(null);
  const [crashLog, setCrashLog] = useState<string | null>(null);
  const [clipStats, setClipStats] = useState<any>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [handlesPlaced, setHandlesPlaced] = useState(false);
  // Text overlay state
  const [overlaySettings, setOverlaySettings] = useState<OverlaySettings | null>(null);
  const [overlayModalOpen, setOverlayModalOpen] = useState(false);
  const playerRef = useRef<any>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const playerReadyRef = useRef(false);
  const previewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playheadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [videoHeight, setVideoHeight] = useState<number | null>(null);
  const [playerWidth, setPlayerWidth] = useState(700);

  // Track video container height for transcript matching
  useEffect(() => {
    const el = videoContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setVideoHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [videoId]);

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

  // Check GCS availability when video changes
  useEffect(() => {
    if (!videoId) { setGcsAvailable(null); return; }
    setGcsAvailable(null);
    fetch(`/api/clip-gcs-check?videoId=${videoId}`)
      .then(r => r.json())
      .then(d => setGcsAvailable(!!d.available))
      .catch(() => setGcsAvailable(false));
  }, [videoId]);

  // Track player container width for proportional overlay font scaling
  useEffect(() => {
    const el = playerContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPlayerWidth(entry.contentRect.width));
    ro.observe(el);
    setPlayerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [videoId]);

  // Load Google Fonts for overlay preview
  useEffect(() => {
    if (document.getElementById("gfonts-overlay")) return;
    const link = document.createElement("link");
    link.id = "gfonts-overlay";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Roboto&family=Open+Sans&family=Lato&family=Montserrat&family=Oswald&family=Raleway&family=Poppins&family=Nunito&family=Ubuntu&family=Merriweather&family=Playfair+Display&family=Bebas+Neue&family=Anton&family=Righteous&family=Lobster&family=Pacifico&family=Bangers&family=Permanent+Marker&family=Press+Start+2P&family=Black+Ops+One&family=Bungee&family=Caveat&family=Dancing+Script&family=Satisfy&family=Alfa+Slab+One&family=Archivo+Black&family=Barlow+Condensed&family=Cinzel&family=Comfortaa&family=Fjalla+One&display=swap";
    document.head.appendChild(link);
  }, []);

  // Load YouTube IFrame API
  useEffect(() => {
    if ((window as any).YT?.Player) return;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(s);
  }, []);

  // Mount player when videoId changes — GCS or YouTube
  useEffect(() => {
    if (!videoId || gcsAvailable === null) return; // wait for GCS check
    playerReadyRef.current = false;

    if (gcsAvailable) {
      // GCS: use native HTML5 video
      const container = document.getElementById("clip-player");
      if (!container) return;
      container.innerHTML = "";
      const video = document.createElement("video");
      video.src = `https://storage.googleapis.com/snippysaurus-clips/videos/${videoId}.mp4`;
      video.poster = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      video.controls = true;
      video.setAttribute("controlsList", "nodownload nofullscreen");
      video.setAttribute("disablePictureInPicture", "true");
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.backgroundColor = "#000";
      video.addEventListener("loadedmetadata", () => {
        playerReadyRef.current = true;
        setDuration(video.duration);
        setHandlesPlaced(false);
        setStartSec(0);
        setEndSec(0);
        setPlayheadSec(0);
      });
      container.appendChild(video);
      videoElRef.current = video;
      // Wrap as playerRef adapter for compatibility
      playerRef.current = {
        seekTo: (sec: number) => { video.currentTime = sec; },
        getCurrentTime: () => video.currentTime,
        getDuration: () => video.duration,
        playVideo: () => video.play(),
        pauseVideo: () => video.pause(),
        getPlayerState: () => (video.paused ? 2 : 1),
        setPlaybackRate: (r: number) => { video.playbackRate = r; },
        getVideoData: () => ({ title: "" }),
        destroy: () => { video.pause(); video.src = ""; },
      };
    } else {
      // YouTube: original iframe player
      const mount = () => {
        const container = document.getElementById("clip-player");
        if (!container) return;
        container.innerHTML = "";
        playerRef.current = new (window as any).YT.Player(container, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: { rel: 0, modestbranding: 1, iv_load_policy: 3, disablekb: 1 },
          events: {
            onReady: (e: any) => {
              playerReadyRef.current = true;
              const dur = e.target.getDuration();
              setDuration(dur);
              setHandlesPlaced(false);
              setStartSec(0);
              setEndSec(0);
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
    }

    return () => {
      if (previewTimerRef.current) clearInterval(previewTimerRef.current);
      if (playheadTimerRef.current) clearInterval(playheadTimerRef.current);
      if (playerRef.current?.destroy) {
        try { playerRef.current.destroy(); } catch {}
      }
      playerRef.current = null;
      videoElRef.current = null;
    };
  }, [videoId, gcsAvailable]);

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
      if (!handlesPlaced) {
        setHandlesPlaced(true);
        setStartSec(sec);
        setEndSec(Math.min(duration, sec + 10));
      }
      setPlayheadSec(sec);
      if (playerReadyRef.current) playerRef.current?.seekTo(sec, true);
    },
    [handlesPlaced, duration],
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

  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (playerReadyRef.current) playerRef.current?.setPlaybackRate(rate);
  };

  const handleTranscriptClick = (sec: number) => {
    if (!handlesPlaced) {
      setHandlesPlaced(true);
      setStartSec(sec);
      setEndSec(Math.min(duration, sec + 10));
    } else {
      const mid = (startSec + endSec) / 2;
      if (sec < mid) {
        setStartSec(Math.min(sec, endSec - 0.01));
      } else {
        setEndSec(Math.max(sec, startSec + 0.01));
      }
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
    startDownload({
      videoId, title, startSec, endSec, quality,
      ...(overlaySettings?.text ? {
        overlay: {
          text: overlaySettings.text,
          xPct: overlaySettings.xPct,
          yPct: overlaySettings.yPct,
          fontSize: overlaySettings.fontSize,
          fontFamily: overlaySettings.fontFamily,
          color: overlaySettings.color,
          opacity: overlaySettings.opacity / 100,
          bgBox: overlaySettings.bgBox,
          bgColor: overlaySettings.bgColor,
          bgOpacity: overlaySettings.bgOpacity,
        },
      } : {}),
    });
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

      {videoId && (
        <>
          {/* Player + Transcript side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-3" ref={videoContainerRef}>
              <div ref={playerContainerRef} className="aspect-video bg-black rounded-xl overflow-hidden relative [&:fullscreen]:rounded-none [&:fullscreen]:w-screen [&:fullscreen]:h-screen [&:fullscreen]:flex [&:fullscreen]:items-center [&:fullscreen]:justify-center">
                <div id="clip-player" className="w-full h-full" />
                {/* Custom fullscreen button — fullscreens container so overlay shows */}
                <button
                  onClick={() => {
                    const el = playerContainerRef.current;
                    if (!el) return;
                    if (document.fullscreenElement) document.exitFullscreen();
                    else el.requestFullscreen();
                  }}
                  className="absolute top-2 right-2 z-20 w-8 h-8 flex items-center justify-center rounded bg-black/50 text-white hover:bg-black/70 text-xs"
                  title="Fullscreen with overlay"
                >
                  &#x26F6;
                </button>
                {overlaySettings?.text && (
                  <div
                    className="absolute pointer-events-none"
                    style={{
                      left: `${(overlaySettings.xPct ?? 0.05) * 100}%`,
                      top: `${(overlaySettings.yPct ?? 0.85) * 100}%`,
                      transform: "translate(0, -100%)",
                      fontSize: `${overlaySettings.fontSize / 1920 * playerWidth}px`,
                      color: overlaySettings.color,
                      opacity: overlaySettings.opacity / 100,
                      ...(overlaySettings.bgBox ? {
                        backgroundColor: (() => {
                          const hex = overlaySettings.bgColor || "#000000";
                          const r = parseInt(hex.slice(1, 3), 16);
                          const g = parseInt(hex.slice(3, 5), 16);
                          const b = parseInt(hex.slice(5, 7), 16);
                          return `rgba(${r},${g},${b},${(overlaySettings.bgOpacity ?? 50) / 100})`;
                        })(),
                        padding: "4px 10px", borderRadius: 4,
                      } : {}),
                      fontFamily: `'${overlaySettings.fontFamily || "Roboto"}', sans-serif`,
                      fontWeight: 700,
                      textShadow: overlaySettings.bgBox ? "none" : "1px 1px 3px rgba(0,0,0,0.8)",
                      zIndex: 10,
                    }}
                  >
                    {overlaySettings.text}
                  </div>
                )}
              </div>
            </div>
            <div className="lg:col-span-2" style={videoHeight ? { height: videoHeight } : undefined}>
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
            playbackRate={playbackRate}
            onPlaybackRateChange={handlePlaybackRateChange}
            handlesPlaced={handlesPlaced}
            onAddText={() => setOverlayModalOpen(true)}
            hasOverlay={!!overlaySettings?.text}
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
                onClick={handlePlayPause}
                className={`${btnClass} min-w-[80px]`}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = DINO_RED_HOVER)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                {isPlaying ? "Pause" : "Play"}
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

              {videoId && (
                <span
                  className="px-2 py-1 rounded text-xs font-semibold"
                  style={{
                    backgroundColor: gcsAvailable === true ? "#166534" : gcsAvailable === false ? "#854d0e" : "#374151",
                    color: "#fff",
                  }}
                >
                  {gcsAvailable === null ? "checking..." : gcsAvailable ? "GCS" : "RapidAPI-realtime"}
                </span>
              )}

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
                      const allData = {
                        ...(clipStats ? { clipStats } : {}),
                        ...(crashLog ? { crashLog } : {}),
                        ...(renderInfo ? { renderInfo } : {}),
                        ...(systemInfo ? { systemInfo } : {}),
                        debugLogs,
                      };
                      navigator.clipboard.writeText(JSON.stringify(allData, null, 2));
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
                  <button
                    onClick={async () => {
                      await fetch("/api/download-debug", { method: "DELETE" });
                      setDebugLogs([]);
                    }}
                    className="px-2 py-1 rounded border border-red-700 text-red-300 hover:bg-red-900/30"
                  >
                    Clear
                  </button>
                  <button
                    onClick={async () => {
                      const res = await fetch("/api/download-system");
                      setSystemInfo(await res.json());
                    }}
                    className="px-2 py-1 rounded border border-blue-700 text-blue-300 hover:bg-blue-900/30"
                  >
                    System Info
                  </button>
                  <button
                    onClick={async () => {
                      const res = await fetch("/api/download-render");
                      setRenderInfo(await res.json());
                    }}
                    className="px-2 py-1 rounded border border-purple-700 text-purple-300 hover:bg-purple-900/30"
                  >
                    Resources
                  </button>
                  <button
                    onClick={async () => {
                      const res = await fetch("/api/download-crash");
                      const data = await res.json();
                      setCrashLog(data.crashLog || "(no crash log)");
                    }}
                    className="px-2 py-1 rounded border border-orange-700 text-orange-300 hover:bg-orange-900/30"
                  >
                    Crash Log
                  </button>
                  <button
                    onClick={async () => {
                      const res = await fetch("/api/download-clip-stats");
                      setClipStats(await res.json());
                    }}
                    className="px-2 py-1 rounded border border-green-700 text-green-300 hover:bg-green-900/30"
                  >
                    Clip Stats
                  </button>
                </div>
              </div>
              {clipStats && (
                <pre className="whitespace-pre-wrap break-all border border-green-900 rounded p-3 bg-green-950/30 text-green-200">{JSON.stringify(clipStats, null, 2)}</pre>
              )}
              {crashLog && (
                <pre className="whitespace-pre-wrap break-all border border-orange-900 rounded p-3 bg-orange-950/30 text-orange-200">{crashLog}</pre>
              )}
              {renderInfo && (
                <pre className="whitespace-pre-wrap break-all border border-purple-900 rounded p-3 bg-purple-950/30 text-purple-200">{JSON.stringify(renderInfo, null, 2)}</pre>
              )}
              {systemInfo && (
                <pre className="whitespace-pre-wrap break-all border border-blue-900 rounded p-3 bg-blue-950/30 text-blue-200">{JSON.stringify(systemInfo, null, 2)}</pre>
              )}
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

      {/* Overlay editor modal */}
      {overlayModalOpen && videoId && (
        <OverlayEditorModal
          videoId={videoId}
          gcsAvailable={gcsAvailable === true}
          currentTime={playheadSec}
          duration={duration}
          initial={overlaySettings}
          onSave={(settings) => { setOverlaySettings(settings); setOverlayModalOpen(false); }}
          onClear={() => { setOverlaySettings(null); setOverlayModalOpen(false); }}
          onClose={() => setOverlayModalOpen(false)}
        />
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
