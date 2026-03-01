"use client";

import { MonthEntry } from "./utils/types";
import { Card, CardContent } from "@/components/ui/card";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function MonthView({
  speaker,
  year,
  months,
  onSelect,
  isLoading,
}: {
  speaker: string;
  year: number;
  months: MonthEntry[];
  onSelect: (month: number) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="text-center py-8 text-gray-500">Loading months...</div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-700">
        <span className="text-blue-700">{speaker}</span> &mdash; {year}
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {months.map((entry) => (
          <Card
            key={entry.month}
            className="cursor-pointer hover:border-blue-300 transition-colors"
            onClick={() => onSelect(entry.month)}
          >
            <CardContent className="flex flex-col items-center py-4 px-3">
              <span className="text-lg font-semibold text-gray-800">
                {MONTH_NAMES[entry.month - 1]}
              </span>
              <span className="text-xs text-gray-500 mt-1">
                {entry.videoCount}{" "}
                {entry.videoCount === 1 ? "video" : "videos"}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
      {months.length === 0 && (
        <p className="text-center text-gray-500 py-4">
          No videos found for this period.
        </p>
      )}
    </div>
  );
}
