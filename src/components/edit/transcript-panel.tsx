"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Search, ChevronUp, ChevronDown, X, ChevronRight } from "lucide-react";
import Image from "next/image";

type Line = { start: number; text: string };

interface TranscriptPanelProps {
  videoId: string;
  startSec: number;
  endSec: number;
  playheadSec: number;
  onLineClick: (sec: number) => void;
  onOpenClipFinder?: () => void;
  bare?: boolean;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TranscriptPanel({ videoId, startSec, endSec, playheadSec, onLineClick, onOpenClipFinder, bare }: TranscriptPanelProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [followPlayback, setFollowPlayback] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const startLineRef = useRef<HTMLButtonElement>(null);
  const currentLineRef = useRef<HTMLButtonElement>(null);
  const matchRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { setFollowPlayback(localStorage.getItem("transcript-follow-playback") !== "false"); } catch {}
  }, []);

  const currentLineIdx = useMemo(() => {
    let index = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].start > playheadSec) break;
      index = i;
    }
    return index;
  }, [lines, playheadSec]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setLines([]);
    fetch(`/api/transcript/${videoId}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("Transcript unavailable");
        const data = await r.json();
        if (!Array.isArray(data)) throw new Error("Invalid transcript");
        setLines(data.filter((line) => line && typeof line.start === "number" && Number.isFinite(line.start) && line.start >= 0 && typeof line.text === "string"));
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [videoId, attempt]);

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
  }, [startSec, query, lines]);

  // Search keeps control of the scroll position until its query is cleared.
  // Only scroll when the spoken line changes, so reading stays steady.
  useEffect(() => {
    if (!followPlayback || query.trim()) return;
    const line = currentLineRef.current;
    const container = containerRef.current;
    if (!line || !container) return;
    const row = line.getBoundingClientRect();
    const view = container.getBoundingClientRect();
    if (row.top < view.top || row.bottom > view.bottom) {
      container.scrollTo({
        top: Math.max(0, container.scrollTop + row.top - view.top - 40),
        behavior: "smooth",
      });
    }
  }, [currentLineIdx, followPlayback, query, lines]);

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

  const shellClass = bare
    ? "flex flex-col h-full"
    : "bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col h-full";

  if (loading) {
    return (
      <div className={bare ? "p-5 h-full flex items-center justify-center" : "bg-white rounded-xl border border-gray-200 p-5 shadow-sm h-full flex items-center justify-center"}>
        <p className="text-sm text-gray-400">Loading transcript...</p>
      </div>
    );
  }

  if (error) return <div role="alert" className="p-5 text-sm text-gray-600">The transcript could not be loaded. <button className="underline min-h-11" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>;

  if (lines.length === 0) {
    return (
      <div className={bare ? "p-5 h-full flex items-center justify-center" : "bg-white rounded-xl border border-gray-200 p-5 shadow-sm h-full flex items-center justify-center"}>
        <p className="text-sm text-gray-400">No transcript available</p>
      </div>
    );
  }

  // Find first line in range for ref
  const firstInRangeIdx = lines.findIndex((l) => l.start >= startSec && l.start < endSec);
  const matchSet = new Set(matchIndices);
  const currentMatchLineIdx = matchIndices.length > 0 ? matchIndices[currentMatchIdx] : -1;

  return (
    <div className={shellClass}>
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
              aria-label="Search transcript"
              className="w-full pl-7 pr-7 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-300 focus:border-blue-300"
            />
            {query && (
              <button
                aria-label="Clear transcript search"
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
                aria-label="Previous transcript match"
                onClick={goPrev}
                disabled={matchIndices.length === 0}
                className="w-6 h-6 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                aria-label="Next transcript match"
                onClick={goNext}
                disabled={matchIndices.length === 0}
                className="w-6 h-6 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
        <label className="flex w-fit items-center gap-2 min-h-8 text-xs font-medium text-gray-600 cursor-pointer" title="Scroll to the current spoken line. Paused while searching.">
          <input
            type="checkbox"
            checked={followPlayback}
            onChange={(e) => {
              setFollowPlayback(e.target.checked);
              try { localStorage.setItem("transcript-follow-playback", String(e.target.checked)); } catch {}
            }}
            className="h-4 w-4 accent-green-700"
          />
          Follow playback
        </label>
      </div>
      <div
        ref={containerRef}
        data-testid="transcript-scroll"
        className="overflow-y-auto flex-1 p-3 space-y-0.5"
      >
        {lines.map((line, i) => {
          const inRange = line.start >= startSec && line.start < endSec;
          const isFirstInRange = i === firstInRangeIdx;
          const isMatch = matchSet.has(i);
          const isCurrentMatch = i === currentMatchLineIdx;
          const isCurrentLine = i === currentLineIdx;

          let bgClass = "hover:bg-gray-50 border-l-2 border-l-transparent";
          if (isCurrentMatch) {
            bgClass = "bg-orange-100 border-l-2 border-l-orange-400";
          } else if (isMatch) {
            bgClass = "bg-yellow-50 border-l-2 border-l-yellow-400";
          } else if (isCurrentLine) {
            bgClass = "bg-blue-50 border-l-2 border-l-blue-600";
          } else if (inRange) {
            bgClass = "bg-green-50 border-l-2 border-l-[#99cc66]";
          }

          return (
            <button
              type="button"
              data-testid="transcript-line"
              data-start={line.start}
              aria-current={isCurrentLine ? "true" : undefined}
              key={i}
              ref={(el) => {
                if (isFirstInRange && !query.trim()) startLineRef.current = el;
                if (isCurrentLine) currentLineRef.current = el;
                if (isMatch && el) matchRefs.current.set(i, el);
                else matchRefs.current.delete(i);
              }}
              onClick={() => onLineClick(line.start)}
              className={`flex w-full text-left min-h-11 gap-2 px-2 py-2 rounded cursor-pointer transition-colors text-sm focus-visible:outline-2 focus-visible:outline-green-600 ${bgClass}`}
            >
              <span className="text-[10px] text-gray-400 font-mono w-8 shrink-0 pt-0.5">
                {formatTime(line.start)}
              </span>
              <span className={inRange || isMatch || isCurrentLine ? "text-gray-800" : "text-gray-500"}>
                {line.text}
              </span>
            </button>
          );
        })}
      </div>
      {onOpenClipFinder && (
        <button
          onClick={onOpenClipFinder}
          className="border-t border-gray-200 px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-green-50 transition-colors shrink-0"
          style={{ background: "linear-gradient(to bottom, #f9fdfb, #f0fdf4)" }}
        >
          <Image src="/snippysaurus-logo.png" alt="" width={34} height={34} className="rounded-lg" />
          <div className="text-left">
            <div className="text-[15px] font-bold text-green-600">Find Snippets</div>
          </div>
          <ChevronRight className="ml-auto h-5 w-5 text-green-300" />
        </button>
      )}
    </div>
  );
}
