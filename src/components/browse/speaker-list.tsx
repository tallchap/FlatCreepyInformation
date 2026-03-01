"use client";

import { Speaker } from "./utils/types";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

export function SpeakerList({
  speakers,
  onSelect,
  isLoading,
}: {
  speakers: Speaker[];
  onSelect: (speaker: string) => void;
  isLoading: boolean;
}) {
  const [filter, setFilter] = useState("");

  const filtered = filter
    ? speakers.filter((s) =>
        s.name.toLowerCase().includes(filter.toLowerCase()),
      )
    : speakers;

  // Group speakers by first letter
  const grouped = useMemo(() => {
    const groups: Record<string, Speaker[]> = {};
    for (const speaker of filtered) {
      const firstChar = speaker.name.charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(firstChar) ? firstChar : "#";
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(speaker);
    }
    return Object.entries(groups).sort(([a], [b]) => {
      if (a === "#") return 1;
      if (b === "#") return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          size={16}
        />
        <Input
          placeholder="Filter speakers..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="text-center py-8 text-gray-500">
          Loading speakers...
        </div>
      ) : (
        <div className="border rounded-lg bg-white divide-y divide-gray-100">
          {grouped.map(([letter, items]) => (
            <div key={letter}>
              {/* Letter header */}
              <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                  {letter}
                </span>
              </div>
              {/* Speaker rows */}
              {items.map((speaker) => (
                <div
                  key={speaker.name}
                  className="px-4 py-2 cursor-pointer hover:bg-blue-50 transition-colors flex items-center justify-between"
                  onClick={() => onSelect(speaker.name)}
                >
                  <span className="text-sm text-gray-800">
                    {speaker.name}
                  </span>
                  <span className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                    ({speaker.videoCount}{" "}
                    {speaker.videoCount === 1 ? "video" : "videos"})
                  </span>
                </div>
              ))}
            </div>
          ))}

          {filtered.length === 0 && (
            <p className="text-center text-gray-500 py-4">
              No speakers match your filter.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
