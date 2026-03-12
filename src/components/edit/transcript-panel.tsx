"use client";

import { useEffect, useRef, useState } from "react";

type Line = { start: number; text: string };

interface TranscriptPanelProps {
  videoId: string;
  startSec: number;
  endSec: number;
  onLineClick: (sec: number) => void;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TranscriptPanel({ videoId, startSec, endSec, onLineClick }: TranscriptPanelProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const startLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/transcript/${videoId}`)
      .then((r) => r.json())
      .then((data: Line[]) => {
        setLines(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [videoId]);

  // Scroll to start of selection when startSec changes
  useEffect(() => {
    if (startLineRef.current && containerRef.current) {
      const lineTop = startLineRef.current.offsetTop - containerRef.current.offsetTop;
      const viewTop = containerRef.current.scrollTop;
      const viewBottom = viewTop + containerRef.current.clientHeight;
      if (lineTop < viewTop || lineTop > viewBottom - 40) {
        containerRef.current.scrollTo({
          top: Math.max(0, lineTop - 60),
          behavior: "smooth",
        });
      }
    }
  }, [startSec]);

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm h-full flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading transcript...</p>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm h-full flex items-center justify-center">
        <p className="text-sm text-gray-400">No transcript available</p>
      </div>
    );
  }

  // Find first line in range for ref
  const firstInRangeIdx = lines.findIndex((l) => l.start >= startSec && l.start < endSec);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Transcript
        </span>
        <span className="text-xs text-gray-400 ml-2">
          Click a line to adjust clip range
        </span>
      </div>
      <div
        ref={containerRef}
        className="overflow-y-auto flex-1 p-3 space-y-0.5"
        style={{ maxHeight: 360 }}
      >
        {lines.map((line, i) => {
          const inRange = line.start >= startSec && line.start < endSec;
          const isFirstInRange = i === firstInRangeIdx;
          return (
            <div
              key={i}
              ref={isFirstInRange ? startLineRef : undefined}
              onClick={() => onLineClick(line.start)}
              className={`flex gap-2 px-2 py-1 rounded cursor-pointer transition-colors text-sm ${
                inRange
                  ? "bg-green-50 border-l-2 border-l-[#99cc66]"
                  : "hover:bg-gray-50 border-l-2 border-l-transparent"
              }`}
            >
              <span className="text-[10px] text-gray-400 font-mono w-8 shrink-0 pt-0.5">
                {formatTime(line.start)}
              </span>
              <span className={inRange ? "text-gray-800" : "text-gray-500"}>
                {line.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
