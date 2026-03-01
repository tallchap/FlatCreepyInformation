"use client";

import { YearEntry } from "./utils/types";
import { Card, CardContent } from "@/components/ui/card";

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
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-700">
        Years for <span className="text-blue-700">{speaker}</span>
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {years.map((entry) => (
          <Card
            key={entry.year}
            className="cursor-pointer hover:border-blue-300 transition-colors"
            onClick={() => onSelect(entry.year)}
          >
            <CardContent className="flex flex-col items-center py-4 px-3">
              <span className="text-xl font-bold text-gray-800">
                {entry.year}
              </span>
              <span className="text-xs text-gray-500 mt-1">
                {entry.videoCount}{" "}
                {entry.videoCount === 1 ? "video" : "videos"}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
      {years.length === 0 && (
        <p className="text-center text-gray-500 py-4">
          No years found for this speaker.
        </p>
      )}
    </div>
  );
}
