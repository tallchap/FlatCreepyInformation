"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Search, ChevronUp, ChevronDown, X } from "lucide-react";

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
  const [query, setQuery] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const startLineRef = useRef<HTMLDivElement>(null);
  const matchRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Compute matching line indices
  const matchIndices = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return lines
      .map((line, i) => (line.text.toLowerCase().includes(q) ? i : -1))
      .filter((i) => i !== -1);
  }, [query, lines]);

  // Reset current match when query changes
  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [query]);

  // Scroll to current match
  useEffect(() => {
    if (matchIndices.length === 0) return;
    const lineIdx = matchIndices[currentMatchIdx];
    const el = matchRefs.current.get(lineIdx);
    if (el && containerRef.current) {
      const lineTop = el.offsetTop - containerRef.current.offsetTop;
      const viewTop = containerRef.current.scrollTop;
      const viewBottom = viewTop + containerRef.current.clientHeight;
      if (lineTop < viewTop || lineTop > viewBottom - 40) {
        containerRef.current.scrollTo({
          top: Math.max(0, lineTop - 60),
          behavior: "smooth",
        });
      }
    }
  }, [currentMatchIdx, matchIndices]);

  // Scroll to start of selection when startSec changes (only when not searching)
  useEffect(() => {
    if (query.trim()) return;
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
  }, [startSec, query]);

  const goNext = useCallback(() => {
    if (matchIndices.length === 0) return;
    setCurrentMatchIdx((prev) => (prev + 1) % matchIndices.length);
  }, [matchIndices]);

  const goPrev = useCallback(() => {
    if (matchIndices.length === 0) return;
    setCurrentMatchIdx((prev) => (prev - 1 + matchIndices.length) % matchIndices.length);
  }, [matchIndices]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
    if (e.key === "Escape") {
      setQuery("");
      searchInputRef.current?.blur();
    }
  };

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
  const matchSet = new Set(matchIndices);
  const currentMatchLineIdx = matchIndices.length > 0 ? matchIndices[currentMatchIdx] : -1;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-100 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Transcript
            </span>
            <span className="text-xs text-gray-400 ml-2">
              Click a line to adjust clip range
            </span>
          </div>
        </div>
        {/* Search bar */}
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search transcript..."
              className="w-full pl-7 pr-7 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-300 focus:border-blue-300"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {query.trim() && (
            <>
              <span className="text-[10px] text-gray-400 whitespace-nowrap min-w-[48px] text-center">
                {matchIndices.length > 0
                  ? `${currentMatchIdx + 1} of ${matchIndices.length}`
                  : "0 of 0"}
              </span>
              <button
                onClick={goPrev}
                disabled={matchIndices.length === 0}
                className="w-6 h-6 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={goNext}
                disabled={matchIndices.length === 0}
                className="w-6 h-6 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        className="overflow-y-auto flex-1 p-3 space-y-0.5"
        style={{ maxHeight: 360 }}
      >
        {lines.map((line, i) => {
          const inRange = line.start >= startSec && line.start < endSec;
          const isFirstInRange = i === firstInRangeIdx;
          const isMatch = matchSet.has(i);
          const isCurrentMatch = i === currentMatchLineIdx;

          let bgClass = "hover:bg-gray-50 border-l-2 border-l-transparent";
          if (isCurrentMatch) {
            bgClass = "bg-orange-100 border-l-2 border-l-orange-400";
          } else if (isMatch) {
            bgClass = "bg-yellow-50 border-l-2 border-l-yellow-400";
          } else if (inRange) {
            bgClass = "bg-green-50 border-l-2 border-l-[#99cc66]";
          }

          return (
            <div
              key={i}
              ref={(el) => {
                if (isFirstInRange && !query.trim()) startLineRef.current = el;
                if (isMatch && el) matchRefs.current.set(i, el);
                else matchRefs.current.delete(i);
              }}
              onClick={() => onLineClick(line.start)}
              className={`flex gap-2 px-2 py-1 rounded cursor-pointer transition-colors text-sm ${bgClass}`}
            >
              <span className="text-[10px] text-gray-400 font-mono w-8 shrink-0 pt-0.5">
                {formatTime(line.start)}
              </span>
              <span className={inRange || isMatch ? "text-gray-800" : "text-gray-500"}>
                {line.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
