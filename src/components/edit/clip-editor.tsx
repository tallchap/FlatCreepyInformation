"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Timeline } from "./timeline";
import { TranscriptPanel } from "./transcript-panel";
import { PlaybackPosition } from "./playback-position";
import { ClipFinder } from "./clip-finder";
import { useDownload } from "@/lib/download-context";
import { OverlayEditorModal, type OverlaySettings } from "./overlay-editor-modal";
import { ClipsSection } from "./clips-section";
import { mountYouTubeCleanPlayer, type CleanPlayer } from "./youtube-clean-player";
import { formatEta } from "@/components/download-panel";
import type { Storyboard } from "@/lib/youtube-storyboard";
import {
  MAX_CLIP_SEC, MIN_SEGMENT_SEC, formatSegTime, formatTotal, lengthToSec, validateSegments, type ClipSegment,
} from "@/lib/clip-segments";

import { clampEditorRange, editorHref, readEditorRange } from "@/lib/editor-link";

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

const META_DESC_LIMIT = 220;
function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf(" ", limit);
  const truncated = text.slice(0, cut > 0 ? cut : limit).replace(/[,;:\-–—'")\]}\s]+$/, "");
  return truncated + "...";
}

export function ClipEditor({ enableClipFinder }: { enableClipFinder?: boolean } = {}) {
  const [videoId, setVideoId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [selection, setSelection] = useState<ClipSegment | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const segments = selection ? [selection] : [];
  const startSec = selection?.in ?? 0;
  const endSec = selection?.out ?? 0;
  const handlesPlaced = selection !== null;
  const [legacyRanges, setLegacyRanges] = useState(false);
  const updateSelection = useCallback((patch: Partial<ClipSegment>) => {
    setSelection((prev) => clampEditorRange({ ...(prev || { in: patch.in ?? 0, out: (patch.in ?? 0) + 10 }), ...patch }, duration));
  }, [duration]);
  const setStartSec = useCallback((v: number) => updateSelection({ in: Math.max(0, Math.min(v, selection ? endSec - MIN_SEGMENT_SEC : Infinity)) }), [updateSelection, endSec, selection]);
  const setEndSec = useCallback((v: number) => updateSelection({ out: v }), [updateSelection]);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // Exports are always requested at 1080p; the server uses the best the
  // source has (720p when there is no 1080p).
  const quality: Quality = "1080p";
  const { startDownload } = useDownload();
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<any[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);
  const [systemInfo, setSystemInfo] = useState<any>(null);
  const [renderInfo, setRenderInfo] = useState<any>(null);
  const [crashLog, setCrashLog] = useState<string | null>(null);
  const [clipStats, setClipStats] = useState<any>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [shieldOn, setShieldOn] = useState(true);
  // Text overlay state
  const [overlaySettings, setOverlaySettings] = useState<OverlaySettings | null>(null);
  const [overlayModalOpen, setOverlayModalOpen] = useState(false);
  const [clipFinderOpen, setClipFinderOpen] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState<{ start: number; text: string }[]>([]);
  const playerRef = useRef<any>(null);
  const playerReadyRef = useRef(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playheadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const videoWrapperRef = useRef<HTMLDivElement>(null);
  const [videoHeight, setVideoHeight] = useState<number | null>(null);
  const [playerWidth, setPlayerWidth] = useState(700);
  const [videoMeta, setVideoMeta] = useState<{ title?: string; channel?: string; published?: string; speakers?: string; description?: string; video_length?: string; video_source?: "bunny" | "youtube"; storyboard?: Storyboard } | null>(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [metaDescExpanded, setMetaDescExpanded] = useState(false);

  useEffect(() => {
    if (!videoId) { setVideoMeta(null); setMetaLoaded(false); return; }
    setMetaDescExpanded(false);
    setMetaLoaded(false);
    fetch(`/api/video-meta?videoId=${videoId}&storyboard=1`)
      .then((r) => r.json())
      .then((data) => { setVideoMeta(data); setDuration(lengthToSec(data.video_length) || 0); })
      .catch(() => setVideoMeta(null))
      .finally(() => setMetaLoaded(true));
  }, [videoId]);

  const clampSelection = useCallback((dur: number) => {
    const current = selectionRef.current;
    const range = current ? clampEditorRange(current, dur) : null;
    setSelection(range);
    setPlayheadSec(range?.in ?? 0);
  }, []);

  const leftColRef = useRef<HTMLDivElement>(null);
  const lockedHeightRef = useRef<number | null>(null);

  // Track left column height (video + collapsed description) for transcript pane
  useEffect(() => {
    const el = leftColRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      // Only update height when description is NOT expanded
      if (!metaDescExpanded) {
        const h = entry.contentRect.height;
        setVideoHeight(h);
        lockedHeightRef.current = h;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [videoId, metaDescExpanded]);

  // Preserve old bookmarked ranges, but edit only the first one.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = extractVideoId(params.get("v") || "");
    if (id) setVideoId(id);
    const { range, hadMultiple } = readEditorRange(params);
    setSelection(range);
    setLegacyRanges(hadMultiple);
  }, []);

  // One shareable Start/End range; no multi-range state in the editor.
  useEffect(() => {
    if (!videoId || !playerReadyRef.current) return;
    window.history.replaceState(null, "", editorHref(videoId, selection?.in, selection?.out));
  }, [selection, videoId]);

  // Fetch transcript for Clip Finder
  useEffect(() => {
    if (!videoId || !enableClipFinder) return;
    fetch(`/api/transcript/${videoId}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setTranscriptLines(data);
      })
      .catch(() => {});
  }, [videoId, enableClipFinder]);

  // Track video wrapper width for proportional overlay font scaling
  useEffect(() => {
    const el = videoWrapperRef.current;
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

  // Playback and export both use YouTube, even when a stored copy exists.
  useEffect(() => {
    if (!videoId || !metaLoaded) return;
    const container = document.getElementById("clip-player");
    if (!container) return;
    playerReadyRef.current = false;
    setPlayerError(null);
    playerRef.current = mountYouTubeCleanPlayer(container, videoId, {
      onReady: (p: CleanPlayer) => {
        playerReadyRef.current = true;
        const dur = p.getDuration() || lengthToSec(videoMeta?.video_length) || 0;
        setDuration(dur);
        const start = selectionRef.current?.in;
        clampSelection(dur);
        if (start != null) p.seekTo(clampEditorRange({ in: start, out: start + 10 }, dur).in, true);
      },
      onError: () => setPlayerError("YouTube could not play this video. Its transcript is still available below."),
    });
    setShieldOn(true);
    return () => {
      if (previewTimerRef.current) clearInterval(previewTimerRef.current);
      try { playerRef.current?.destroy(); } catch {}
      playerRef.current = null;
      playerReadyRef.current = false;
    };
  }, [videoId, metaLoaded]);

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
      if (document.activeElement?.closest("input, textarea, select, button, a, [contenteditable=true], [role=dialog]")) return;
      e.preventDefault();
      if (!playerReadyRef.current) return;
      handlePlayPause();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isPlaying, handlesPlaced, endSec]);

  // "≈ 2 min" next to Export: the download service's estimate for these segments.
  const [exportEta, setExportEta] = useState<number | null>(null);
  const segKey = selection ? `${selection.in}-${selection.out}` : "";
  useEffect(() => {
    if (!videoId || !segments.length || validateSegments(segments, duration)) { setExportEta(null); return; }
    const t = setTimeout(() => {
      fetch("/api/clip-estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, quality, segments }),
      })
        .then((r) => r.json())
        .then((d) => setExportEta(typeof d.etaSec === "number" ? d.etaSec : null))
        .catch(() => setExportEta(null));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, segKey, quality]);

  const clipDuration = endSec - startSec;
  const clipTotal = Math.max(0, clipDuration);
  const clipError = selection ? validateSegments(segments, duration) : null;
  const clipTooLong = !!clipError;

  const selectRange = useCallback((inSec: number, outSec: number) => {
    setSelection(clampEditorRange({ in: inSec, out: outSec }, duration));
  }, [duration]);

  const stopPreview = useCallback(() => {
    if (previewTimerRef.current) clearInterval(previewTimerRef.current);
  }, []);

  const handleStartChange = useCallback(
    (sec: number) => {
      const start = Math.max(0, Math.min(sec, endSec - MIN_SEGMENT_SEC));
      setStartSec(start);
      if (playerReadyRef.current) playerRef.current?.seekTo(start, true);
    },
    [setStartSec, endSec],
  );

  const handleEndChange = useCallback(
    (sec: number) => setEndSec(sec),
    [setEndSec],
  );

  const handleSeek = useCallback(
    (sec: number) => {
      if (!handlesPlaced) selectRange(sec, sec + 10);
      setPlayheadSec(sec);
      if (playerReadyRef.current) playerRef.current?.seekTo(sec, true);
    },
    [handlesPlaced, duration, selectRange],
  );

  // Auto-pause at endSec helper (the preview never runs past the out point)
  const startAutoPause = () => {
    stopPreview();
    previewTimerRef.current = setInterval(() => {
      const t = playerRef.current?.getCurrentTime?.();
      if (t != null && selectionRef.current && t >= selectionRef.current.out) {
        playerRef.current?.pauseVideo();
        if (previewTimerRef.current) clearInterval(previewTimerRef.current);
      }
    }, 100);
  };

  const handleFromStart = () => {
    if (!playerReadyRef.current) return;
    if (handlesPlaced) {
      playerRef.current?.seekTo(startSec, true);
      playerRef.current?.playVideo();
      startAutoPause();
    } else {
      playerRef.current?.seekTo(0, true);
      playerRef.current?.playVideo();
    }
  };

  const handlePlayPause = () => {
    if (!playerReadyRef.current) return;
    if (isPlaying) {
      playerRef.current?.pauseVideo();
      stopPreview();
    } else {
      playerRef.current?.playVideo();
      if (handlesPlaced) startAutoPause();
    }
  };

  const handleLast5 = () => {
    if (!playerReadyRef.current) return;
    if (handlesPlaced) {
      playerRef.current?.seekTo(Math.max(startSec, endSec - 3), true);
    } else {
      const t = playerRef.current?.getCurrentTime?.() ?? 0;
      playerRef.current?.seekTo(Math.max(0, t - 3), true);
    }
    playerRef.current?.playVideo();
    if (handlesPlaced) startAutoPause();
  };

  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (playerReadyRef.current) playerRef.current?.setPlaybackRate(rate);
  };

  // The first transcript click selects a clip; later clicks move its nearer handle.
  const handleTranscriptClick = (sec: number) => {
    if (!handlesPlaced) {
      selectRange(sec, sec + 10);

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

  // A Clip Finder result replaces the current clip.
  const handleSnippetSelect = (start: number, end: number) => {
    selectRange(start, end);
    if (playerReadyRef.current) {
      playerRef.current?.seekTo(start, true);
      playerRef.current?.playVideo();
      setIsPlaying(true);
    }
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
    if (!videoId || clipTooLong || !segments.length) return;
    const title = videoMeta?.title || playerRef.current?.getVideoData?.()?.title || videoId;
    startDownload({
      videoId, title, quality,
      segments: segments.map((s) => ({ in: s.in, out: s.out })),
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
        <h1 className="text-2xl font-bold text-gray-900">Snippet Editor</h1>
        <p className="text-sm text-gray-500 mt-1">
          Select one clip in the transcript, adjust Start and End, then export (max {MAX_CLIP_SEC / 60} min) &middot; Spacebar to play/pause
        </p>
      </div>

      {legacyRanges && <p role="status" className="text-sm text-amber-800">This saved link contained multiple ranges. The editor now uses one clip, so only the first range is selected.</p>}
      {!videoId && <p className="text-sm text-gray-600">Open a video from Chat, Search, or Browse to select a clip.</p>}
      {playerError && <p role="alert" className="text-sm text-red-700">{playerError}</p>}
      {videoId && (
        <>
          {/* Player + Transcript side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-3" ref={(el) => { videoContainerRef.current = el; leftColRef.current = el; }}>
              <div ref={playerContainerRef} className="bg-black rounded-xl overflow-hidden [&:fullscreen]:rounded-none [&:fullscreen]:w-screen [&:fullscreen]:h-screen [&:fullscreen]:flex [&:fullscreen]:items-center [&:fullscreen]:justify-center">
                <div ref={videoWrapperRef} className="relative aspect-video w-full max-h-full">
                  <div id="clip-player" className="w-full h-full" />
                  <PlaybackPosition seconds={playheadSec} duration={duration} overlay />
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
                  {(
                    <div className="absolute top-2 left-2 z-20 flex items-center gap-1">
                      <span data-testid="yt-only-badge" className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-black/60 text-white pointer-events-none">
                        YouTube
                      </span>
                      <button
                        onClick={() => { const v = !shieldOn; setShieldOn(v); playerRef.current?.setShield?.(v); }}
                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-black/60 text-white hover:bg-black/80"
                        title="Let clicks through to YouTube (e.g. to skip an ad)"
                      >
                        {shieldOn ? "Ad? click-through" : "Back to editing"}
                      </button>
                    </div>
                  )}
                  {/* HIDDEN FOR NOW: overlay preview
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
                          padding: `${4 / 1920 * playerWidth}px ${10 / 1920 * playerWidth}px`, borderRadius: 4,
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
                  */}
                </div>
              </div>
              {videoMeta?.title && (
                <div className="mt-2">
                  <h3 className="text-base font-bold text-gray-900 line-clamp-2 leading-snug">{videoMeta.title}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {[videoMeta.channel, typeof videoMeta.published === "object" ? (videoMeta.published as any)?.value : videoMeta.published].filter(Boolean).join(" · ")}
                  </p>
                  {videoMeta.description && (
                    <p className="text-sm text-gray-600 mt-1">
                      {metaDescExpanded ? (
                        <>
                          {videoMeta.description}{" "}
                          <button onClick={() => setMetaDescExpanded(false)} className="text-blue-500 font-medium">Show less</button>
                        </>
                      ) : (
                        <>
                          {truncateAtWord(videoMeta.description, META_DESC_LIMIT)}
                          {videoMeta.description.length > META_DESC_LIMIT && (
                            <>
                              {" "}
                              <button onClick={() => setMetaDescExpanded(true)} className="text-blue-500 font-medium">See more</button>
                            </>
                          )}
                        </>
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="lg:col-span-2 flex flex-col h-[380px] lg:h-[var(--transcript-height)] lg:max-h-[var(--transcript-height)]" style={{ "--transcript-height": `${videoHeight || 440}px` } as React.CSSProperties}>
              {enableClipFinder ? (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col flex-1 overflow-hidden">
                  {/* Tab bar */}
                  <div className="flex border-b border-gray-100 shrink-0">
                    <button
                      onClick={() => setClipFinderOpen(true)}
                      className={`flex-1 py-2.5 text-[13px] font-semibold text-center transition-colors border-b-2 ${
                        clipFinderOpen
                          ? "text-green-600 border-green-600"
                          : "text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      Clip Finder
                    </button>
                    <button
                      onClick={() => setClipFinderOpen(false)}
                      className={`flex-1 py-2.5 text-[13px] font-semibold text-center transition-colors border-b-2 ${
                        !clipFinderOpen
                          ? "text-green-600 border-green-600"
                          : "text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      Transcript
                    </button>
                  </div>
                  {/* Tab content */}
                  <div className="flex-1 overflow-hidden">
                    {clipFinderOpen ? (
                      <ClipFinder
                        transcript={transcriptLines}
                        onSelectSnippet={handleSnippetSelect}
                        onClose={() => setClipFinderOpen(false)}
                      />
                    ) : (
                      <TranscriptPanel
                        videoId={videoId}
                        startSec={startSec}
                        endSec={endSec}
                        playheadSec={playheadSec}
                        onLineClick={handleTranscriptClick}
                        bare
                      />
                    )}
                  </div>
                </div>
              ) : (
                <TranscriptPanel
                  videoId={videoId}
                  startSec={startSec}
                  endSec={endSec}
                  playheadSec={playheadSec}
                  onLineClick={handleTranscriptClick}
                />
              )}
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
            isPlaying={isPlaying}
            onPlayPause={handlePlayPause}
            onFromStart={handleFromStart}
            onLast5={handleLast5}
            storyboard={videoMeta?.storyboard ?? null}
            clipRangeNode={
              <>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] font-medium text-gray-500 uppercase">Start</label>
                  <TimeInput label="Start" value={startSec} onChange={setStartSec} />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] font-medium text-gray-500 uppercase">End</label>
                  <TimeInput label="End" value={endSec} onChange={setEndSec} />
                </div>
                <div className="text-[11px] text-gray-500">
                  Clip:{" "}
                  <span className="font-semibold text-gray-700 font-mono">{formatDuration(Math.max(0, clipDuration))}</span>
                  {clipTooLong && (
                    <span role="alert" className="text-red-500 ml-1">{clipError}</span>
                  )}
                </div>
              </>
            }
          />

          <div>
          {/* Controls */}
          <div className="bg-white rounded-xl border border-gray-200 px-5 py-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => { setDebugOpen((v) => !v); if (!debugOpen) void loadDebugLogs(); }}
                className="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap"
              >
                {debugOpen ? "Hide Debug" : "Show Debug"}
              </button>
              <div className="flex-1" />
              <button
                onClick={handleExport}
                disabled={clipTooLong || !segments.length}
                data-testid="export-snippet"
                className={btnClass}
                style={{ backgroundColor: DINO_RED }}
                onMouseEnter={(e) => { if (!clipTooLong) e.currentTarget.style.backgroundColor = DINO_RED_HOVER; }}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = DINO_RED)}
              >
                Export Snippet
              </button>
              {exportEta != null && segments.length > 0 && (
                <span className="text-[12px] text-gray-500 whitespace-nowrap" data-testid="export-estimate" title="Estimated time from Export to the file">
                  ready in {formatEta(exportEta)}
                </span>
              )}
            </div>
          </div>

          <div hidden data-testid="segment-list" data-segments={JSON.stringify(segments)} />
          {selection && <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600 mt-3" data-testid="segment-active" data-in={startSec} data-out={endSec}>
            <span data-testid="segment-text">{formatSegTime(startSec)} → {formatSegTime(endSec)}</span>
            <span data-testid="segment-total">{formatTotal(clipTotal)}</span>
            <button onClick={() => { stopPreview(); setSelection(null); }} className="underline min-h-11 px-2" data-testid="clear-selection">Clear selection</button>
          </div>}
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

      {/* Clips section — loads last, only if clips exist */}
      {videoId && <ClipsSection videoId={videoId} />}

      {/* HIDDEN FOR NOW: overlay editor modal
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
      */}
    </div>
  );
}

/* ── Editable MM:SS.ms input ── */

function TimeInput({ label, value, onChange }: { label: string; value: number; onChange: (sec: number) => void }) {
  const [text, setText] = useState(formatDuration(value));
  useEffect(() => { setText(formatDuration(value)); }, [value]);

  const commit = () => {
    const match = text.trim().match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
    const seconds = match ? Number(match[1]) * 60 + Number(match[2])
      : /^\d+(?:\.\d+)?$/.test(text.trim()) ? Number(text) : NaN;
    // Always restore the displayed value; a clamped/no-op change may not
    // trigger a new value effect (e.g. entering an End beyond the video).
    setText(formatDuration(value));
    if (Number.isFinite(seconds)) onChange(seconds);
  };

  return (
    <input
      type="text"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="w-24 text-center rounded border border-gray-300 px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-400"
    />
  );
}
