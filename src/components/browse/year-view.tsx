"use client";

import { YearEntry } from "./utils/types";

export function YearView({
  speaker,
  years,
  onSelect,
  isLoading,
}: {
  speaker: string;
  years: YearEntry[];
  onSelect: (year: number) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="text-center py-8 text-gray-500">Loading years...</div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider px-1">
        Years for <span className="text-blue-700 normal-case">{speaker}</span>
      </h2>
      <div className="border rounded-lg bg-white divide-y divide-gray-100">
        {years.map((entry) => (
          <div
            key={entry.year}
            className="px-4 py-2.5 cursor-pointer hover:bg-blue-50 transition-colors flex items-center justify-between"
            onClick={() => onSelect(entry.year)}
          >
            <span className="text-sm font-medium text-gray-800">
              {entry.year}
            </span>
            <span className="text-xs text-gray-400 ml-2">
              ({entry.videoCount}{" "}
              {entry.videoCount === 1 ? "video" : "videos"})
            </span>
          </div>
        ))}
        {years.length === 0 && (
          <p className="text-center text-gray-500 py-4">
            No years found for this speaker.
          </p>
        )}
      </div>
    </div>
  );
}
