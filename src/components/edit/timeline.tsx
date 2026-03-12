"use client";

import { useCallback, useRef, useState } from "react";

interface TimelineProps {
  duration: number; // total seconds
  startSec: number;
  endSec: number;
  playheadSec: number;
  onStartChange: (sec: number) => void;
  onEndChange: (sec: number) => void;
  onSeek: (sec: number) => void;
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
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | "playhead" | null>(null);

  const pctOf = (sec: number) => (duration > 0 ? (sec / duration) * 100 : 0);

  const secFromX = useCallback(
    (clientX: number) => {
      if (!trackRef.current || duration <= 0) return 0;
      const rect = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(pct * duration);
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
    const sec = secFromX(e.clientX);
    if (dragging === "start") {
      onStartChange(Math.min(sec, endSec - 1));
    } else if (dragging === "end") {
      onEndChange(Math.max(sec, startSec + 1));
    } else if (dragging === "playhead") {
      onSeek(sec);
    }
  };

  const handlePointerUp = () => setDragging(null);

  const handleTrackClick = (e: React.MouseEvent) => {
    if (dragging) return;
    const sec = secFromX(e.clientX);
    onSeek(sec);
  };

  const handleTrackPointerDown = (e: React.PointerEvent) => {
    // If clicking empty track (not a handle), start playhead drag
    if ((e.target as HTMLElement).dataset.handle) return;
    setDragging("playhead");
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // Generate waveform bars (decorative) — stable via ref
  const barsRef = useRef(Array.from({ length: 120 }, () => 8 + Math.random() * 30));
  const bars = barsRef.current;

  // Time axis labels
  const ticks = 5;
  const tickLabels = Array.from({ length: ticks }, (_, i) =>
    formatTime((duration / (ticks - 1)) * i),
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Timeline
        </span>
        <span className="text-xs text-gray-400">
          Total: {formatTime(duration)}
        </span>
      </div>

      <div className="relative pt-7 pb-2">
        {/* Time labels above handles */}
        <div
          className="absolute top-0 text-[11px] font-semibold text-[#99cc66] bg-green-50 px-1.5 py-0.5 rounded"
          style={{ left: `${pctOf(startSec)}%`, transform: "translateX(-50%)" }}
        >
          {formatTime(startSec)}
        </div>
        <div
          className="absolute top-0 text-[11px] font-semibold text-red-500 bg-red-50 px-1.5 py-0.5 rounded"
          style={{ left: `${pctOf(endSec)}%`, transform: "translateX(-50%)" }}
        >
          {formatTime(endSec)}
        </div>

        {/* Track */}
        <div
          ref={trackRef}
          className="relative h-12 bg-gray-100 rounded-lg overflow-visible cursor-pointer select-none"
          onClick={handleTrackClick}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
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
          <div
            className="absolute top-0 bottom-0 bg-[#99cc66]/25 border-l-[3px] border-l-[#99cc66] border-r-[3px] border-r-red-500"
            style={{
              left: `${pctOf(startSec)}%`,
              width: `${pctOf(endSec) - pctOf(startSec)}%`,
            }}
          />

          {/* Playhead */}
          <div
            className="absolute top-[-6px] bottom-[-6px] z-20 pointer-events-none"
            style={{ left: `${pctOf(playheadSec)}%`, transform: "translateX(-50%)" }}
          >
            {/* Line */}
            <div className="absolute left-1/2 -translate-x-1/2 top-[6px] bottom-[6px] w-[2px] bg-white shadow-[0_0_3px_rgba(0,0,0,0.5)]" />
            {/* Triangle head */}
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
          <div
            data-handle="start"
            className="absolute top-[-4px] bottom-[-4px] w-3.5 bg-[#99cc66] rounded cursor-ew-resize z-10 flex items-center justify-center"
            style={{ left: `${pctOf(startSec)}%`, transform: "translateX(-50%)" }}
            onPointerDown={handlePointerDown("start")}
          >
            <div className="w-0.5 h-4 bg-white/80 rounded pointer-events-none" />
          </div>

          {/* End handle */}
          <div
            data-handle="end"
            className="absolute top-[-4px] bottom-[-4px] w-3.5 bg-red-500 rounded cursor-ew-resize z-10 flex items-center justify-center"
            style={{ left: `${pctOf(endSec)}%`, transform: "translateX(-50%)" }}
            onPointerDown={handlePointerDown("end")}
          >
            <div className="w-0.5 h-4 bg-white/80 rounded pointer-events-none" />
          </div>
        </div>

        {/* Time axis */}
        <div className="flex justify-between mt-2 text-[10px] text-gray-400 px-1">
          {tickLabels.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
