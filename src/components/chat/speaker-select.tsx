"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { FEATURED_SPEAKERS } from "../clip-chat/speakers";
import { ChevronDown } from "lucide-react";

export function speakerInitial(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() || "?";
}

interface Speaker {
  name: string;
  slug: string;
  videoCount: number;
}

interface SpeakerSelectProps {
  value: string;
  onValueChange: (value: string, speakerName?: string) => void;
  disabled?: boolean;
  name?: string;
}

export function SpeakerSelect({
  value,
  onValueChange,
  disabled,
  name,
}: SpeakerSelectProps) {
  const [dynamicSpeakers, setDynamicSpeakers] = useState<Speaker[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [highlightIndex, setHighlightIndex] = useState(-1);

  useEffect(() => {
    fetch("/api/speakers")
      .then((r) => r.json())
      .then((data) => setDynamicSpeakers(data.speakers || []))
      .catch(() => {});
  }, []);

  const allSpeakers = useMemo(() => {
    const speakers = new Map<string, Speaker>(
      FEATURED_SPEAKERS.map((person) => [
        person.slug,
        { ...person, videoCount: 0 },
      ]),
    );
    dynamicSpeakers.forEach((person) => speakers.set(person.slug, person));
    return [...speakers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [dynamicSpeakers]);

  // The display name for the selected speaker
  const selectedName = useMemo(() => {
    if (value === "all") return "All Speakers";
    const sp = allSpeakers.find((s) => s.slug === value);
    return sp?.name || name || "";
  }, [value, allSpeakers, name]);

  const filtered = useMemo(() => {
    if (!search) return allSpeakers;
    const q = search.toLowerCase();
    return allSpeakers.filter((s) => s.name.toLowerCase().includes(q));
  }, [allSpeakers, search]);

  // Items to render: "All Speakers" + filtered list (capped at 200)
  const items = useMemo(() => {
    const result: { slug: string; label: string }[] = [];
    // Only show "All Speakers" if search is empty or it matches
    if (!search || "all speakers".includes(search.toLowerCase())) {
      result.push({ slug: "all", label: "All Speakers (search everything)" });
    }
    for (const s of filtered.slice(0, 200)) {
      result.push({ slug: s.slug, label: `${s.name} (${s.videoCount})` });
    }
    return result;
  }, [filtered, search]);

  function selectItem(slug: string) {
    const sp = allSpeakers.find((s) => s.slug === slug);
    onValueChange(slug, slug === "all" ? "All Speakers" : sp?.name);
    setSearch("");
    setOpen(false);
    setHighlightIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < items.length) {
        selectItem(items[highlightIndex].slug);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
      setHighlightIndex(-1);
    }
  }

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return;
    const el = listRef.current.children[highlightIndex] as HTMLElement;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          aria-label={`Choose speaker, current: ${selectedName || "none"}`}
          className="flex items-center gap-2 w-full min-w-0 max-w-[320px] rounded-xl border border-[#dce3d3] bg-white px-2 sm:px-3 py-2 text-sm hover:bg-[#f5f7f0] focus:outline-none focus:ring-2 focus:ring-[#99cc66] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            setOpen(true);
            // Focus input on next tick
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <span
            data-speaker-initial
            aria-hidden="true"
            className="grid place-items-center shrink-0 w-8 h-8 rounded-lg bg-[#e7eddb] text-[#52683d] font-semibold"
          >
            {speakerInitial(selectedName)}
          </span>
          <span className="min-w-0 text-left flex-1">
            <span className="block text-[10px] text-[#78856b]">Speaker</span>
            <span className="block truncate text-[#20352b] font-medium">
              {selectedName || "Choose a speaker"}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[min(320px,calc(100vw-48px))] rounded-md border border-gray-200 bg-white shadow-lg animate-in fade-in-0 zoom-in-95"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <div className="p-2 border-b border-gray-100">
            <input
              ref={inputRef}
              type="text"
              placeholder="Type to search speakers..."
              aria-label="Search speakers"
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#99cc66] focus:border-transparent"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setHighlightIndex(-1);
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div ref={listRef} className="max-h-[300px] overflow-y-auto p-1">
            {items.map((item, i) => (
              <button
                key={item.slug}
                aria-label={item.label}
                className={`flex items-center gap-3 w-full text-left px-3 py-2 text-sm rounded-sm cursor-pointer transition-colors ${
                  i === highlightIndex
                    ? "bg-[#99cc66]/20 text-gray-900"
                    : item.slug === value
                      ? "bg-gray-100 text-gray-900 font-medium"
                      : "text-gray-700 hover:bg-gray-100"
                }`}
                onClick={() => selectItem(item.slug)}
                onMouseEnter={() => setHighlightIndex(i)}
              >
                <span
                  data-speaker-initial
                  aria-hidden="true"
                  className="grid place-items-center shrink-0 w-7 h-7 rounded-lg bg-[#e7eddb] text-[#52683d] text-xs font-semibold"
                >
                  {speakerInitial(item.label)}
                </span>
                <span>{item.label}</span>
              </button>
            ))}
            {filtered.length > 200 && (
              <div className="px-3 py-2 text-xs text-gray-400">
                {filtered.length - 200} more — keep typing to narrow results
              </div>
            )}
            {search && items.length === 0 && (
              <div className="px-3 py-2 text-sm text-gray-400">
                No speakers found
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
