"use client";

import { useCallback, useRef, useState } from "react";

interface TimelineProps {
  duration: number; // total seconds
  startSec: number;
  endSec: number;
  onStartChange: (sec: number) => void;
  onEndChange: (sec: number) => void;
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
  onStartChange,
  onEndChange,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);

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
    setDragging(handle);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const sec = secFromX(e.clientX);
    if (dragging === "start") {
      onStartChange(Math.min(sec, endSec - 1));
    } else {
      onEndChange(Math.max(sec, startSec + 1));
    }
  };

  const handlePointerUp = () => setDragging(null);

  const handleTrackClick = (e: React.MouseEvent) => {
    if (dragging) return;
    const sec = secFromX(e.clientX);
    // Click left half of selection → move start, right half → move end
    const mid = (startSec + endSec) / 2;
    if (sec < mid) {
      onStartChange(Math.min(sec, endSec - 1));
    } else {
      onEndChange(Math.max(sec, startSec + 1));
    }
  };

  // Generate waveform bars (decorative)
  const bars = Array.from({ length: 120 }, () => 8 + Math.random() * 30);

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
          className="relative h-12 bg-gray-100 rounded-lg overflow-hidden cursor-pointer select-none"
          onClick={handleTrackClick}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {/* Waveform bars */}
          <div className="absolute inset-0 flex items-center gap-[1px] px-2">
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

          {/* Start handle */}
          <div
            className="absolute top-[-4px] bottom-[-4px] w-3.5 bg-[#99cc66] rounded cursor-ew-resize z-10 flex items-center justify-center"
            style={{ left: `${pctOf(startSec)}%`, transform: "translateX(-50%)" }}
            onPointerDown={handlePointerDown("start")}
          >
            <div className="w-0.5 h-4 bg-white/80 rounded" />
          </div>

          {/* End handle */}
          <div
            className="absolute top-[-4px] bottom-[-4px] w-3.5 bg-red-500 rounded cursor-ew-resize z-10 flex items-center justify-center"
            style={{ left: `${pctOf(endSec)}%`, transform: "translateX(-50%)" }}
            onPointerDown={handlePointerDown("end")}
          >
            <div className="w-0.5 h-4 bg-white/80 rounded" />
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
