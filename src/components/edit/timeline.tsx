"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import type { Storyboard } from "@/lib/youtube-storyboard";

const CLIP_COLOR = "#99cc66";

const FRAME_STEP = 2 / 30; // 2 frames at 30fps ≈ 0.067s
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

interface TimelineProps {
  duration: number;
  startSec: number;
  endSec: number;
  playheadSec: number;
  onStartChange: (sec: number) => void;
  onEndChange: (sec: number) => void;
  onSeek: (sec: number) => void;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  handlesPlaced: boolean;
  onAddText?: () => void;
  hasOverlay?: boolean;
  isPlaying?: boolean;
  onPlayPause?: () => void;
  onFromStart?: () => void;
  onLast5?: () => void;
  clipRangeNode?: React.ReactNode;
  /** yt-only videos: YouTube storyboard sprites instead of the waveform bars. */
  storyboard?: Storyboard | null;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Timeline({
  duration,
  startSec,
  endSec,
  playheadSec,
  onStartChange,
  onEndChange,
  onSeek,
  playbackRate,
  onPlaybackRateChange,
  handlesPlaced,
  onAddText,
  hasOverlay,
  isPlaying,
  onPlayPause,
  onFromStart,
  onLast5,
  clipRangeNode,
  storyboard,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | "playhead" | "minimap" | null>(null);
  const [zoom, setZoom] = useState(5);
  const [panCenter, setPanCenter] = useState<number | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setTrackWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Suppress browser zoom over timeline (non-passive wheel listener)
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const suppress = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
    el.addEventListener("wheel", suppress, { passive: false });
    return () => el.removeEventListener("wheel", suppress);
  }, []);

  // Visible window
  const visibleDuration = duration / zoom;
  const center = panCenter ?? (startSec + endSec) / 2;
  const visibleStart = Math.max(0, Math.min(duration - visibleDuration, center - visibleDuration / 2));
  const visibleEnd = visibleStart + visibleDuration;

  const pctOf = useCallback(
    (sec: number) => {
      if (visibleDuration <= 0) return 0;
      return ((sec - visibleStart) / visibleDuration) * 100;
    },
    [visibleStart, visibleDuration],
  );

  const clampPct = (pct: number) => Math.max(0, Math.min(100, pct));

  // No rounding — millisecond precision
  const secFromX = useCallback(
    (clientX: number) => {
      if (!trackRef.current || duration <= 0) return 0;
      const rect = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return visibleStart + pct * visibleDuration;
    },
    [duration, visibleStart, visibleDuration],
  );

  const secFromMinimapX = useCallback(
    (clientX: number) => {
      if (!minimapRef.current || duration <= 0) return 0;
      const rect = minimapRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return pct * duration;
    },
    [duration],
  );

  const handlePointerDown = (handle: "start" | "end") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(handle);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    if (dragging === "minimap") {
      const sec = secFromMinimapX(e.clientX);
      const clamped = Math.max(visibleDuration / 2, Math.min(duration - visibleDuration / 2, sec));
      setPanCenter(clamped);
      return;
    }
    const sec = secFromX(e.clientX);
    if (dragging === "start") {
      onStartChange(Math.min(sec, endSec - 0.01));
    } else if (dragging === "end") {
      onEndChange(Math.max(sec, startSec + 0.01));
    } else if (dragging === "playhead") {
      onSeek(Math.max(0, Math.min(duration, sec)));
    }
  };

  const handlePointerUp = () => setDragging(null);

  const handleTrackClick = (e: React.MouseEvent) => {
    if (dragging) return;
    const sec = secFromX(e.clientX);
    onSeek(Math.max(0, Math.min(duration, sec)));
  };

  const handleTrackPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.handle) return;
    setDragging("playhead");
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // Minimap drag
  const handleMinimapPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging("minimap");
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const sec = secFromMinimapX(e.clientX);
    const clamped = Math.max(visibleDuration / 2, Math.min(duration - visibleDuration / 2, sec));
    setPanCenter(clamped);
  };

  // Wheel to pan when zoomed
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();

    // Pinch-to-zoom or Ctrl+scroll → zoom centered on cursor
    if (e.ctrlKey || e.metaKey) {
      const zoomDelta = e.deltaY > 0 ? -1 : 1;
      const newZoom = Math.max(1, Math.min(50, zoom + zoomDelta));

      // Zoom toward cursor position
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const cursorPct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const cursorSec = visibleStart + cursorPct * visibleDuration;

      if (newZoom === 1) {
        setPanCenter(null);
      } else {
        setPanCenter(cursorSec);
      }
      setZoom(newZoom);
      return;
    }

    // Normal scroll → pan (only when zoomed)
    if (zoom <= 1) return;
    const delta = (e.deltaX || e.deltaY) * (visibleDuration / 500);
    const newCenter = Math.max(
      visibleDuration / 2,
      Math.min(duration - visibleDuration / 2, (panCenter ?? center) + delta),
    );
    setPanCenter(newCenter);
  };

  const handleZoomChange = (newZoom: number) => {
    const clamped = Math.max(1, Math.min(50, newZoom));
    if (clamped === 1) {
      setPanCenter(null);
    } else if (panCenter === null) {
      setPanCenter((startSec + endSec) / 2);
    }
    setZoom(clamped);
  };

  const barsRef = useRef(Array.from({ length: 120 }, () => 8 + Math.random() * 30));
  const bars = barsRef.current;

  const ticks = 5;
  const tickLabels = useMemo(
    () =>
      Array.from({ length: ticks }, (_, i) =>
        formatTime(visibleStart + (visibleDuration / (ticks - 1)) * i),
      ),
    [visibleStart, visibleDuration, ticks],
  );

  const isVisible = (sec: number) => sec >= visibleStart && sec <= visibleEnd;
  const startVisible = isVisible(startSec);
  const endVisible = isVisible(endSec);

  const regionLeft = clampPct(pctOf(startSec));
  const regionRight = clampPct(pctOf(endSec));
  const regionWidth = Math.max(0, regionRight - regionLeft);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-1">
          {onFromStart && (
            <>
              <button
                onClick={onFromStart}
                className="px-2 py-1 text-[11px] font-semibold rounded text-white hover:opacity-90"
                style={{ backgroundColor: "#DC2626" }}
              >
                From Start
              </button>
              <button
                onClick={onPlayPause}
                className="px-2 py-1 text-[11px] font-semibold rounded text-white hover:opacity-90 min-w-[52px]"
                style={{ backgroundColor: "#DC2626" }}
              >
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button
                onClick={onLast5}
                className="px-2 py-1 text-[11px] font-semibold rounded text-white hover:opacity-90"
                style={{ backgroundColor: "#DC2626" }}
              >
                Last 3s
              </button>
            </>
          )}
        </div>
        {clipRangeNode && (
          <div className="flex flex-wrap items-center gap-3">
            {clipRangeNode}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleZoomChange(zoom - 1)}
              disabled={zoom <= 1}
              className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-xs font-bold text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              -
            </button>
            <span className="text-xs text-gray-500 w-8 text-center font-mono">
              {zoom}x
            </span>
            <button
              onClick={() => handleZoomChange(zoom + 1)}
              disabled={zoom >= 50}
              className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-xs font-bold text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              +
            </button>
          </div>
          <div className="w-px h-4 bg-gray-200" />
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                const idx = SPEED_OPTIONS.indexOf(playbackRate);
                if (idx > 0) onPlaybackRateChange(SPEED_OPTIONS[idx - 1]);
              }}
              disabled={SPEED_OPTIONS.indexOf(playbackRate) <= 0}
              className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-xs font-bold text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              &#x00AB;
            </button>
            <span className="text-xs font-mono text-gray-600 w-8 text-center">
              {playbackRate}x
            </span>
            <button
              onClick={() => {
                const idx = SPEED_OPTIONS.indexOf(playbackRate);
                if (idx < SPEED_OPTIONS.length - 1) onPlaybackRateChange(SPEED_OPTIONS[idx + 1]);
              }}
              disabled={SPEED_OPTIONS.indexOf(playbackRate) >= SPEED_OPTIONS.length - 1}
              className="w-6 h-6 flex items-center justify-center rounded border border-gray-300 text-xs font-bold text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              &#x00BB;
            </button>
          </div>
          <span className="text-xs text-gray-400">
            Total: {formatTime(duration)}
          </span>
        </div>
      </div>

      <div className="relative pt-1 pb-2">
        {/* Track */}
        <div
          ref={trackRef}
          className="relative h-12 bg-gray-100 rounded-lg overflow-visible cursor-pointer select-none"
          onClick={handleTrackClick}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
        >
          {storyboard ? (
            <Filmstrip storyboard={storyboard} visibleStart={visibleStart} visibleDuration={visibleDuration} width={trackWidth} />
          ) : (
            /* Waveform bars */
            <div className="absolute inset-0 flex items-center gap-[1px] px-2 overflow-hidden rounded-lg">
              {bars.map((h, i) => (
                <div
                  key={i}
                  className="flex-1 bg-gray-300 rounded-sm min-w-[2px]"
                  style={{ height: h }}
                />
              ))}
            </div>
          )}

          {/* Selected region */}
          {handlesPlaced && regionWidth > 0 && (
            <div
              data-testid="segment-band-active"
              className="absolute top-0 bottom-0 pointer-events-none flex items-start justify-center"
              style={{
                left: `${regionLeft}%`,
                width: `${regionWidth}%`,
                backgroundColor: `${CLIP_COLOR}40`,
                borderLeft: startVisible ? `3px solid ${CLIP_COLOR}` : undefined,
                borderRight: endVisible ? "3px solid #ef4444" : undefined,
              }}
            >
            </div>
          )}

          {/* Playhead */}
          <div
            className="absolute top-[-6px] bottom-[-6px] z-20 pointer-events-none"
            style={{ left: `${clampPct(pctOf(playheadSec))}%`, transform: "translateX(-50%)" }}
          >
            <div className="absolute left-1/2 -translate-x-1/2 top-[6px] bottom-[6px] w-[2px] bg-white shadow-[0_0_3px_rgba(0,0,0,0.5)]" />
            <div
              className="absolute left-1/2 -translate-x-1/2 top-0 w-0 h-0"
              style={{
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderTop: "7px solid white",
                filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))",
              }}
            />
          </div>

          {/* Start handle */}
          {handlesPlaced && startVisible && (
            <div
              data-handle="start"
              className="absolute top-[-4px] bottom-[-4px] w-3.5 bg-[#99cc66] rounded cursor-ew-resize z-10 flex items-center justify-center"
              style={{ left: `${clampPct(pctOf(startSec))}%`, transform: "translateX(-50%)" }}
              onPointerDown={handlePointerDown("start")}
            >
              <div className="w-0.5 h-4 bg-white/80 rounded pointer-events-none" />
            </div>
          )}

          {/* End handle */}
          {handlesPlaced && endVisible && (
            <div
              data-handle="end"
              className="absolute top-[-4px] bottom-[-4px] w-3.5 bg-red-500 rounded cursor-ew-resize z-10 flex items-center justify-center"
              style={{ left: `${clampPct(pctOf(endSec))}%`, transform: "translateX(-50%)" }}
              onPointerDown={handlePointerDown("end")}
            >
              <div className="w-0.5 h-4 bg-white/80 rounded pointer-events-none" />
            </div>
          )}
        </div>

        {/* Time axis */}
        <div className="flex justify-between mt-2 text-[10px] text-gray-400 px-1">
          {tickLabels.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>

        {/* Keep controls separate even when a short clip's handles are adjacent. */}
        {handlesPlaced && <div className="flex flex-wrap justify-between gap-3 mt-2">
            <div
              data-testid="start-frame-controls"
              className="flex items-center gap-1"
            >
              <span className="text-[10px] text-[#99cc66] font-semibold mr-0.5">Start</span>
              <button
                aria-label="Move Start back two frames"
                onClick={() => onStartChange(Math.max(0, startSec - FRAME_STEP))}
                className="w-6 h-5 flex items-center justify-center rounded border border-[#99cc66]/50 text-[10px] font-bold text-[#99cc66] hover:bg-green-50"
              >
                -2f
              </button>
              <button
                aria-label="Move Start forward two frames"
                onClick={() => onStartChange(Math.min(endSec - 0.01, startSec + FRAME_STEP))}
                className="w-6 h-5 flex items-center justify-center rounded border border-[#99cc66]/50 text-[10px] font-bold text-[#99cc66] hover:bg-green-50"
              >
                +2f
              </button>
            </div>
            <div
              data-testid="end-frame-controls"
              className="flex items-center gap-1"
            >
              <span className="text-[10px] text-red-500 font-semibold mr-0.5">End</span>
              <button
                aria-label="Move End back two frames"
                onClick={() => onEndChange(Math.max(startSec + 0.01, endSec - FRAME_STEP))}
                className="w-6 h-5 flex items-center justify-center rounded border border-red-300 text-[10px] font-bold text-red-500 hover:bg-red-50"
              >
                -2f
              </button>
              <button
                aria-label="Move End forward two frames"
                onClick={() => onEndChange(Math.min(duration, endSec + FRAME_STEP))}
                className="w-6 h-5 flex items-center justify-center rounded border border-red-300 text-[10px] font-bold text-red-500 hover:bg-red-50"
              >
                +2f
              </button>
            </div>
        </div>}

        {/* Draggable minimap when zoomed */}
        {zoom > 1 && (
          <div
            ref={minimapRef}
            className="mt-2 relative h-3 bg-gray-200 rounded-full overflow-hidden cursor-pointer select-none"
            onPointerDown={handleMinimapPointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {/* Selection region on minimap */}
            {handlesPlaced && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: `${(startSec / duration) * 100}%`,
                  width: `${((endSec - startSec) / duration) * 100}%`,
                  backgroundColor: `${CLIP_COLOR}66`,
                }}
              />
            )}
            {/* Viewport indicator — draggable */}
            <div
              className="absolute top-0 bottom-0 border-2 border-gray-500 rounded-full bg-white/40 cursor-grab active:cursor-grabbing pointer-events-none"
              style={{
                left: `${(visibleStart / duration) * 100}%`,
                width: `${(visibleDuration / duration) * 100}%`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Filmstrip from YouTube storyboard sprites (yt-only videos) ── */

function Filmstrip({ storyboard, visibleStart, visibleDuration, width }: {
  storyboard: Storyboard; visibleStart: number; visibleDuration: number; width: number;
}) {
  const H = 48;
  if (!width || visibleDuration <= 0) return null;
  if (storyboard.source === "thumbnails") {
    const tileW = Math.round((H * 16) / 9);
    const n = Math.max(1, Math.ceil(width / tileW));
    return (
      <div className="absolute inset-0 flex overflow-hidden rounded-lg opacity-80" data-testid="filmstrip" data-source="thumbnails">
        {Array.from({ length: n }, (_, i) => (
          <div key={i} className="shrink-0 h-full bg-cover bg-center" style={{ width: tileW, backgroundImage: `url(${storyboard.thumbnails[i % storyboard.thumbnails.length]})` }} />
        ))}
      </div>
    );
  }
  // Prefer ~160px-wide tiles (sharp at 48px tall); fall back to the largest level.
  const lv = storyboard.levels.find((l) => l.width >= 120) || storyboard.levels[storyboard.levels.length - 1];
  const scale = H / lv.height;
  const tileW = lv.width * scale;
  const n = Math.max(1, Math.ceil(width / tileW));
  const perSheet = lv.cols * lv.rows;
  return (
    <div className="absolute inset-0 flex overflow-hidden rounded-lg opacity-80" data-testid="filmstrip" data-source="storyboard">
      {Array.from({ length: n }, (_, i) => {
        const t = visibleStart + ((i + 0.5) * tileW / width) * visibleDuration;
        const frame = Math.min(lv.count - 1, Math.max(0, Math.floor((t * 1000) / lv.intervalMs)));
        const sheet = Math.floor(frame / perSheet);
        const k = frame % perSheet;
        const col = k % lv.cols;
        const row = Math.floor(k / lv.cols);
        return (
          <div
            key={i}
            className="shrink-0 h-full"
            style={{
              width: tileW,
              backgroundImage: `url(${lv.sheets[sheet] || lv.sheets[0]})`,
              backgroundSize: `${lv.cols * tileW}px ${lv.rows * H}px`,
              backgroundPosition: `-${col * tileW}px -${row * H}px`,
            }}
          />
        );
      })}
    </div>
  );
}
