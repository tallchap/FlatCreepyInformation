"use client";

import { useState, useEffect } from "react";
import { useDownload, type DownloadItem } from "@/lib/download-context";

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function StatusIcon({ status }: { status: DownloadItem["status"] }) {
  if (status === "complete") {
    return (
      <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  // Spinning loader
  return (
    <svg className="w-4 h-4 text-[#DC2626] animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function DownloadPanel() {
  const { downloads, dismissDownload, clearCompleted, hasActive } = useDownload();
  const [expanded, setExpanded] = useState(false);
  const [prevActiveCount, setPrevActiveCount] = useState(0);

  const activeCount = downloads.filter((d) => d.status === "downloading").length;

  // Auto-expand when a new download starts
  useEffect(() => {
    if (activeCount > prevActiveCount) {
      setExpanded(true);
    }
    setPrevActiveCount(activeCount);
  }, [activeCount, prevActiveCount]);

  // Don't render if no downloads
  if (downloads.length === 0) return null;

  const completedCount = downloads.filter((d) => d.status !== "downloading").length;

  // Collapsed pill
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-full shadow-lg hover:shadow-xl transition-shadow"
      >
        {hasActive ? (
          <svg className="w-4 h-4 text-[#DC2626] animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        )}
        <span className="text-sm font-medium text-gray-700">
          {hasActive ? `${activeCount} downloading` : `${downloads.length} downloads`}
        </span>
      </button>
    );
  }

  // Expanded panel
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 bg-white border border-gray-200 rounded-xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span className="text-sm font-semibold text-gray-700">Downloads</span>
        </div>
        <div className="flex items-center gap-1">
          {completedCount > 0 && (
            <button
              onClick={clearCompleted}
              className="text-[10px] text-gray-400 hover:text-red-500 px-2 py-1 transition-colors"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setExpanded(false)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 transition-colors"
          >
            <svg className="w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Download list */}
      <div className="max-h-64 overflow-y-auto">
        {downloads.map((d) => (
          <div key={d.id} className="px-4 py-3 border-b border-gray-50 last:border-b-0">
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">
                <StatusIcon status={d.status} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{d.title}</p>
                <p className="text-[11px] text-gray-400">
                  {formatTime(d.startSec)} - {formatTime(d.endSec)} &middot; {d.quality}
                </p>
                {d.status === "downloading" && (
                  <div className="mt-1.5 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#DC2626] rounded-full transition-all duration-500 ease-out"
                      style={{ width: `${d.progress}%` }}
                    />
                  </div>
                )}
                {d.status === "error" && d.error && (
                  <p className="text-[11px] text-red-500 mt-0.5">{d.error}</p>
                )}
              </div>
              <button
                onClick={() => dismissDownload(d.id)}
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-100 transition-colors"
              >
                <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
