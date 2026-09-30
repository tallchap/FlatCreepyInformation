"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Search, X } from "lucide-react";
import { getSpeakerLibrary } from "./utils/actions";
import type { SpeakerLibrary, BrowseVideo, BrowseSnippet } from "./utils/types";
import { VideoList } from "./video-list";
import { avatarColor, PAGE_SIZE, yearOf } from "./utils/presentation";
import styles from "./browse.module.css";

export function SpeakerVideosContainer({ speaker }: { speaker: string }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const [library, setLibrary] = useState<SpeakerLibrary>({ videos: [], snippets: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const tab = params.get("tab") === "snippets" ? "snippets" : "videos";
  const year = params.get("year") || "All";
  const query = params.get("q") || "";
  const requestedPage = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(false);
    setLibrary({ videos: [], snippets: [] });
    getSpeakerLibrary(speaker).then((data) => { if (active) setLibrary(data); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [speaker, attempt]);
  const snippetsByVideo = useMemo(() => {
    const map = new Map<string, SpeakerLibrary["snippets"]>();
    for (const snippet of library.snippets) map.set(snippet.videoId, [...(map.get(snippet.videoId) || []), snippet]);
    return map;
  }, [library.snippets]);
  const entries = useMemo(() => library.videos.flatMap<{ key: string; video: BrowseVideo; snippet: BrowseSnippet | null }>((video) => tab === "videos"
    ? [{ key: video.id, video, snippet: null }]
    : (snippetsByVideo.get(video.id) || []).map((snippet) => ({ key: snippet.id, video, snippet }))), [library.videos, snippetsByVideo, tab]);
  const yearCounts = new Map<string, number>();
  for (const entry of entries) {
    const key = yearOf(entry.video.published);
    yearCounts.set(key, (yearCounts.get(key) || 0) + 1);
  }
  const years = [...yearCounts.keys()].sort((a, b) => a === "Undated" ? 1 : b === "Undated" ? -1 : b.localeCompare(a));
  const filtered = entries.filter(({ video, snippet }) => (year === "All" || yearOf(video.published) === year) &&
    `${snippet?.title || video.title} ${video.channel}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  function update(values: Record<string, string | null>) {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    // Next syncs native history with useSearchParams without a server navigation per keystroke.
    window.history.replaceState(null, "", `${pathname}${next.size ? `?${next}` : ""}`);
  }
  return <>
    <header className={styles.speakerHeader}>
      <div className={styles.speakerHeaderInner}>
        <Link className={styles.outlineButton} href="/browse"><ChevronLeft size={14} />All speakers</Link>
        <span className={styles.breadcrumbSlash} aria-hidden="true">/</span>
        <span className={styles.largeAvatar} style={{ background: avatarColor(speaker) }} aria-hidden="true">{Array.from(speaker)[0]}</span>
        <h1>{speaker}</h1>
      </div>
    </header>
    <div className={styles.library}>
      <div className={styles.libraryTabs} role="group" aria-label="Content type">
        <button aria-pressed={tab === "videos"} onClick={() => update({ tab: null, page: null, year: null })}>Videos <span>{isLoading || error ? "—" : library.videos.length.toLocaleString()}</span></button>
        <button aria-pressed={tab === "snippets"} onClick={() => update({ tab: "snippets", page: null, year: null })}>Snippets <span>{isLoading || error ? "—" : library.snippets.length.toLocaleString()}</span></button>
      </div>
      {isLoading ? <p className={styles.empty} role="status">Loading {speaker}’s library…</p> : error ? <div className={styles.empty} role="alert"><p>We couldn’t load this speaker’s library.</p><button className={styles.outlineButton} onClick={() => setAttempt((n) => n + 1)}>Try again</button></div> : <>
        <div className={styles.libraryFilters}>
          <div className={styles.yearFilters} role="group" aria-label="Filter by year">
            {["All", ...years].map((value) => <button key={value} aria-pressed={year === value} onClick={() => update({ year: value === "All" ? null : value, page: null })}>{value}{" "}<span>{value === "All" ? entries.length : yearCounts.get(value)}</span></button>)}
          </div>
          <div className={styles.librarySearch}><Search size={14} aria-hidden="true" /><input aria-label={`Search ${tab}`} placeholder={`Search ${tab}…`} value={query} onChange={(e) => update({ q: e.target.value || null, page: null })} />{query && <button className={styles.iconButton} aria-label="Clear search" onClick={() => update({ q: null, page: null })}><X size={14} /></button>}</div>
        </div>
        <p className={styles.libraryCount} role="status">{filtered.length ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filtered.length)} of ${filtered.length} ${tab}` : `No ${tab} match your filters.`}</p>
        <VideoList entries={filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)} snippetsByVideo={snippetsByVideo} total={filtered.length} page={page} tab={tab} onPageChange={(value) => { update({ page: value === 1 ? null : String(value) }); window.scrollTo({ top: 0 }); }} />
        {!filtered.length && <div className={styles.empty}><p>{entries.length ? "Try another year or search term." : tab === "snippets" ? "No snippets are available for this speaker yet." : "No videos are available for this speaker yet."}</p>{(query || year !== "All") && <button className={styles.outlineButton} onClick={() => update({ q: null, year: null, page: null })}>Clear filters</button>}</div>}
      </>}
    </div>
  </>;
}
