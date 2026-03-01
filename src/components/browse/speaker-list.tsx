"use client";

import { Speaker } from "./utils/types";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import Link from "next/link";

type SortMode = "popularity" | "alphabetical";

export function SpeakerList({
  speakers,
  isLoading,
}: {
  speakers: Speaker[];
  isLoading: boolean;
}) {
  const [sortMode, setSortMode] = useState<SortMode>("popularity");
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

  // Available letters for jump-to nav
  const availableLetters = useMemo(
    () => new Set(grouped.map(([letter]) => letter)),
    [grouped],
  );

  const scrollToLetter = (letter: string) => {
    const el = document.getElementById(`letter-${letter}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // For popularity mode: sort filtered speakers by videoCount descending
  const popularitySorted = useMemo(
    () => [...filtered].sort((a, b) => b.videoCount - a.videoCount),
    [filtered],
  );

  return (
    <div className="space-y-3">
      {/* Sort mode selector + filter */}
      <div className="flex items-center gap-3">
        <Select
          value={sortMode}
          onValueChange={(v) => setSortMode(v as SortMode)}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="popularity">Popularity</SelectItem>
            <SelectItem value="alphabetical">Alphabetical</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative flex-1">
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
      </div>

      {/* Alphabet jump-to navigation (only for alphabetical mode) */}
      {!isLoading && sortMode === "alphabetical" && (
        <div className="flex flex-wrap gap-1 px-1">
          {Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ#").map((letter) => (
            <button
              key={letter}
              onClick={() => scrollToLetter(letter)}
              disabled={!availableLetters.has(letter)}
              className={`w-7 h-7 text-xs font-semibold rounded transition-colors ${
                availableLetters.has(letter)
                  ? "text-blue-600 hover:bg-blue-50 cursor-pointer"
                  : "text-gray-300 cursor-default"
              }`}
            >
              {letter}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-8 text-gray-500">
          Loading speakers...
        </div>
      ) : sortMode === "popularity" ? (
        /* ── Popularity view: flat ranked list ── */
        <div className="border rounded-lg bg-white divide-y divide-gray-100">
          {popularitySorted.map((speaker, idx) => (
            <Link
              key={speaker.name}
              href={`/browse/${encodeURIComponent(speaker.name)}`}
              className="px-4 py-2 hover:bg-blue-50 transition-colors flex items-center justify-between"
            >
              <span className="text-sm text-gray-800">
                <span className="text-xs text-gray-400 mr-2 font-medium">
                  {idx + 1}.
                </span>
                {speaker.name}
              </span>
              <span className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                ({speaker.videoCount}{" "}
                {speaker.videoCount === 1 ? "video" : "videos"})
              </span>
            </Link>
          ))}

          {filtered.length === 0 && (
            <p className="text-center text-gray-500 py-4">
              No speakers match your filter.
            </p>
          )}
        </div>
      ) : (
        /* ── Alphabetical view: grouped A-Z ── */
        <div className="border rounded-lg bg-white divide-y divide-gray-100">
          {grouped.map(([letter, items]) => (
            <div key={letter} id={`letter-${letter}`}>
              {/* Letter header */}
              <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100 sticky top-0 z-10">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                  {letter}
                </span>
              </div>
              {/* Speaker rows */}
              {items.map((speaker) => (
                <Link
                  key={speaker.name}
                  href={`/browse/${encodeURIComponent(speaker.name)}`}
                  className="px-4 py-2 hover:bg-blue-50 transition-colors flex items-center justify-between"
                >
                  <span className="text-sm text-gray-800">
                    {speaker.name}
                  </span>
                  <span className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                    ({speaker.videoCount}{" "}
                    {speaker.videoCount === 1 ? "video" : "videos"})
                  </span>
                </Link>
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
