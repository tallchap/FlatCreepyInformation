"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Speaker } from "./utils/types";
import { avatarColor, initials, initialLetter, PAGE_SIZE, sortSpeakers } from "./utils/presentation";
import { BrowsePagination } from "./pagination";
import styles from "./browse.module.css";

export function SpeakerList({ speakers, isLoading, error = false, onRetry }: {
  speakers: Speaker[]; isLoading: boolean; error?: boolean; onRetry?: () => void;
}) {
  const [sort, setSort] = useState("content");
  const [letter, setLetter] = useState("All");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const available = useMemo(() => new Set(speakers.map((s) => initialLetter(s.name))), [speakers]);
  const filtered = useMemo(() => sortSpeakers(speakers, sort, letter, query), [speakers, sort, letter, query]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  function changePage(value: number) {
    setPage(value);
    document.getElementById("speaker-directory")?.scrollIntoView({ block: "start" });
  }
  return <div className={styles.directory}>
    <header className={styles.directoryHeader}>
      <h1>Browse by speaker</h1>
      <p>{isLoading ? "Loading the speaker directory…" : error ? "The directory is temporarily unavailable." : <><strong>{speakers.length.toLocaleString()} {speakers.length === 1 ? "speaker" : "speakers"}</strong> indexed.</>}</p>
    </header>
    <div className={styles.toolbar} id="speaker-directory">
      <span className={styles.eyebrow}>Sort by</span>
      <div className={styles.segmented} role="group" aria-label="Sort speakers">
        {[ ["content", "Most content"], ["recent", "Most recently updated"], ["alphabetical", "A–Z"] ].map(([value, label]) =>
          <button key={value} aria-pressed={sort === value} onClick={() => { setSort(value); setPage(1); }}>{label}</button>)}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild><button className={styles.findButton}><Search size={13} />Find or jump<ChevronDown size={13} /></button></PopoverTrigger>
        <PopoverContent className={styles.findPopover} align="start" sideOffset={8} collisionPadding={16}>
          <div className={styles.searchBox}>
            <Search size={15} aria-hidden="true" />
            <input aria-label="Find a speaker" placeholder="Type a name or pick a letter" value={query} onChange={(e) => { setQuery(e.target.value); setLetter("All"); setPage(1); }} />
            {query && <button className={styles.iconButton} aria-label="Clear search" onClick={() => { setQuery(""); setPage(1); }}><X size={15} /></button>}
          </div>
          <div className={styles.letterPicker}>
            <p className={styles.eyebrow}>Jump to letter</p>
            <div className={styles.letters}>
              {Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ#").map((value) => <button key={value} disabled={!available.has(value)} aria-pressed={letter === value} aria-label={`Speakers starting with ${value}`} onClick={() => { setLetter(value); setQuery(""); setPage(1); setOpen(false); }}>{value}</button>)}
            </div>
            {letter !== "All" && <button className={styles.resetLetters} onClick={() => { setLetter("All"); setPage(1); }}>Show all letters</button>}
          </div>
          <div className={styles.popoverHint}>esc close</div>
        </PopoverContent>
      </Popover>
      {letter !== "All" && <button className={styles.filterChip} aria-label="Clear letter filter" onClick={() => { setLetter("All"); setPage(1); }}>Filter: {letter}<X size={12} /></button>}
      {query && <button className={styles.filterChip} aria-label="Clear name filter" onClick={() => { setQuery(""); setPage(1); }}>“{query}”<X size={12} /></button>}
      <span className={styles.resultCount} role="status">{!isLoading && !error && (filtered.length ? `${(current - 1) * PAGE_SIZE + 1}–${Math.min(current * PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString()} speakers` : "0 speakers")}</span>
    </div>
    <section aria-label="Speaker directory" aria-busy={isLoading}>
      <div className={styles.columnHead}><span>Speaker</span><span>Total videos</span></div>
      {isLoading ? <p className={styles.empty} role="status">Loading speakers…</p> : error ? <div className={styles.empty} role="alert"><p>We couldn’t load the speakers. Please try again.</p><button className={styles.outlineButton} onClick={onRetry}>Try again</button></div> : <>
        {rows.map((speaker) => <Link key={speaker.name} href={`/browse/${encodeURIComponent(speaker.name)}`} className={styles.speakerRow}>
          <span className={styles.speakerIdentity}><span aria-hidden="true" className={styles.avatar} style={{ backgroundColor: avatarColor(speaker.name) }}>{initials(speaker.name)}</span><span className={styles.speakerName}>{speaker.name}</span></span>
          <span className={styles.videoCount}>{speaker.videoCount.toLocaleString()}</span>
        </Link>)}
        {!rows.length && <div className={styles.empty}><p>{query || letter !== "All" ? "No speakers match your filters." : "No speakers have been indexed yet."}</p>{(query || letter !== "All") && <button className={styles.outlineButton} onClick={() => { setQuery(""); setLetter("All"); setPage(1); }}>Clear filters</button>}</div>}
        <BrowsePagination page={current} totalPages={totalPages} onChange={changePage} />
      </>}
    </section>
  </div>;
}
