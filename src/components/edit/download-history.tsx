"use client";

export interface DownloadRecord {
  id: string;
  videoId: string;
  title: string;
  startSec: number;
  endSec: number;
  quality: string;
  date: string;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface DownloadHistoryProps {
  records: DownloadRecord[];
  onClear: () => void;
}

export function DownloadHistory({ records, onClear }: DownloadHistoryProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Download History
        </span>
        <button
          onClick={onClear}
          className="text-xs text-gray-400 hover:text-red-500 transition-colors"
        >
          Clear
        </button>
      </div>
      <div className="space-y-2">
        {records.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-3 text-sm p-2 rounded-lg hover:bg-gray-50"
          >
            <a
              href={`https://www.youtube.com/watch?v=${r.videoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline truncate flex-1"
            >
              {r.title}
            </a>
            <span className="text-gray-400 text-xs whitespace-nowrap">
              {formatTime(r.startSec)} - {formatTime(r.endSec)}
            </span>
            <span className="text-gray-400 text-xs">{r.quality}</span>
            <span className="text-gray-400 text-xs whitespace-nowrap">
              {new Date(r.date).toLocaleDateString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
