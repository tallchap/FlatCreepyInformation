"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LEGACY_SPEAKERS } from "@/lib/speakers";

interface Speaker {
  name: string;
  slug: string;
  videoCount: number;
}

interface SpeakerSelectProps {
  value: string;
  onValueChange: (value: string, speakerName?: string) => void;
  disabled?: boolean;
}

export function SpeakerSelect({
  value,
  onValueChange,
  disabled,
}: SpeakerSelectProps) {
  const [dynamicSpeakers, setDynamicSpeakers] = useState<Speaker[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/speakers")
      .then((r) => r.json())
      .then((data) => setDynamicSpeakers(data.speakers || []))
      .catch(() => {});
  }, []);

  // Merge: dynamic speakers + legacy (deduped), sorted by video count desc
  const allSpeakers = useMemo(() => {
    const map = new Map<string, Speaker>();

    // Legacy speakers first (they have dedicated stores)
    for (const s of LEGACY_SPEAKERS) {
      map.set(s.slug, { name: s.name, slug: s.slug, videoCount: s.videoCount });
    }

    // Dynamic speakers from API
    for (const s of dynamicSpeakers) {
      if (!map.has(s.slug)) {
        map.set(s.slug, s);
      }
    }

    return [...map.values()].sort((a, b) => b.videoCount - a.videoCount);
  }, [dynamicSpeakers]);

  const filtered = useMemo(() => {
    if (!search) return allSpeakers;
    const q = search.toLowerCase();
    return allSpeakers.filter((s) => s.name.toLowerCase().includes(q));
  }, [allSpeakers, search]);

  return (
    <Select
      value={value}
      onValueChange={(slug) => {
        const sp = allSpeakers.find((s) => s.slug === slug);
        onValueChange(slug, sp?.name);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-[320px]">
        <SelectValue placeholder="Choose a speaker..." />
      </SelectTrigger>
      <SelectContent>
        <div className="px-2 pb-2">
          <input
            type="text"
            placeholder="Search speakers..."
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-white placeholder:text-zinc-500 focus:outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <SelectItem value="all">All Speakers (search everything)</SelectItem>
        {filtered.slice(0, 200).map((speaker) => (
          <SelectItem key={speaker.slug} value={speaker.slug}>
            {speaker.name} ({speaker.videoCount})
          </SelectItem>
        ))}
        {filtered.length > 200 && (
          <div className="px-2 py-1 text-xs text-zinc-500">
            {filtered.length - 200} more — type to search
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
