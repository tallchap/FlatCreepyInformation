"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";

const FRAME_STEP = 2 / 30; // 2 frames at 30fps ≈ 0.067s
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

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
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTimePrecise(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
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
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | "playhead" | "minimap" | null>(null);
  const [zoom, setZoom] = useState(5);
  const [panCenter, setPanCenter] = useState<number | null>(null);

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
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Timeline
        </span>
        <div className="flex items-center gap-3">
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
          {onAddText && (
            <>
              <div className="w-px h-4 bg-gray-200" />
              <button
                onClick={onAddText}
                className="px-2.5 py-1 text-xs font-semibold text-white rounded transition-colors"
                style={{ backgroundColor: hasOverlay ? "#16a34a" : "#DC2626" }}
              >
                {hasOverlay ? "Edit Text" : "Add Text"}
              </button>
            </>
          )}
          <span className="text-xs text-gray-400">
            Total: {formatTime(duration)}
          </span>
        </div>
      </div>

      <div className="relative pt-7 pb-2">
        {/* Precise time labels above handles */}
        {handlesPlaced && startVisible && (
          <div
            className="absolute top-0 text-[11px] font-semibold text-[#99cc66] bg-green-50 px-1.5 py-0.5 rounded z-30 font-mono"
            style={{ left: `${clampPct(pctOf(startSec))}%`, transform: "translateX(-50%)" }}
          >
            {formatTimePrecise(startSec)}
          </div>
        )}
        {handlesPlaced && endVisible && (
          <div
            className="absolute top-0 text-[11px] font-semibold text-red-500 bg-red-50 px-1.5 py-0.5 rounded z-30 font-mono"
            style={{ left: `${clampPct(pctOf(endSec))}%`, transform: "translateX(-50%)" }}
          >
            {formatTimePrecise(endSec)}
          </div>
        )}

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
          {/* Waveform bars */}
          <div className="absolute inset-0 flex items-center gap-[1px] px-2 overflow-hidden rounded-lg">
            {bars.map((h, i) => (
              <div
                key={i}
                className="flex-1 bg-gray-300 rounded-sm min-w-[2px]"
                style={{ height: h }}
              />
            ))}
          </div>

          {/* Selected region */}
          {handlesPlaced && regionWidth > 0 && (
            <div
              className="absolute top-0 bottom-0 bg-[#99cc66]/25"
              style={{
                left: `${regionLeft}%`,
                width: `${regionWidth}%`,
                borderLeft: startVisible ? "3px solid #99cc66" : undefined,
                borderRight: endVisible ? "3px solid #ef4444" : undefined,
              }}
            />
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

        {/* Start/End frame-nudge buttons aligned with markers */}
        {handlesPlaced && <div className="relative h-7 mt-1">
          {startVisible && (
            <div
              className="absolute flex items-center gap-0.5 z-10"
              style={{ left: `${clampPct(pctOf(startSec))}%`, transform: "translateX(-50%)" }}
            >
              <span className="text-[10px] text-[#99cc66] font-semibold mr-0.5">Start</span>
              <button
                onClick={() => onStartChange(Math.max(0, startSec - FRAME_STEP))}
                className="w-6 h-5 flex items-center justify-center rounded border border-[#99cc66]/50 text-[10px] font-bold text-[#99cc66] hover:bg-green-50"
              >
                -2f
              </button>
              <button
                onClick={() => onStartChange(Math.min(endSec - 0.01, startSec + FRAME_STEP))}
                className="w-6 h-5 flex items-center justify-center rounded border border-[#99cc66]/50 text-[10px] font-bold text-[#99cc66] hover:bg-green-50"
              >
                +2f
              </button>
            </div>
          )}
          {endVisible && (
            <div
              className="absolute flex items-center gap-0.5 z-10"
              style={{ left: `${clampPct(pctOf(endSec))}%`, transform: "translateX(-50%)" }}
            >
              <span className="text-[10px] text-red-500 font-semibold mr-0.5">End</span>
              <button
                onClick={() => onEndChange(Math.max(startSec + 0.01, endSec - FRAME_STEP))}
                className="w-6 h-5 flex items-center justify-center rounded border border-red-300 text-[10px] font-bold text-red-500 hover:bg-red-50"
              >
                -2f
              </button>
              <button
                onClick={() => onEndChange(Math.min(duration, endSec + FRAME_STEP))}
                className="w-6 h-5 flex items-center justify-center rounded border border-red-300 text-[10px] font-bold text-red-500 hover:bg-red-50"
              >
                +2f
              </button>
            </div>
          )}
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
            {handlesPlaced && <div
              className="absolute top-0 bottom-0 bg-[#99cc66]/40 pointer-events-none"
              style={{
                left: `${(startSec / duration) * 100}%`,
                width: `${((endSec - startSec) / duration) * 100}%`,
              }}
            />}
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
