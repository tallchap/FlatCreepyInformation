"use client";

import { useId, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ChevronRight, Play, Scissors } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { BrowseSnippet, BrowseVideo } from "./utils/types";
import { displayDate, duration, PAGE_SIZE, yearOf } from "./utils/presentation";
import { BrowsePagination } from "./pagination";
import styles from "./browse.module.css";

type Entry = { key: string; video: BrowseVideo; snippet: BrowseSnippet | null };

export function VideoList({ entries, snippetsByVideo, total, page, tab, onPageChange }: {
  entries: Entry[]; snippetsByVideo: Map<string, BrowseSnippet[]>; total: number; page: number;
  tab: string; onPageChange: (page: number) => void;
}) {
  const [playing, setPlaying] = useState<Entry | null>(null);
  const [mediaError, setMediaError] = useState(false);
  function play(entry: Entry) { setMediaError(false); setPlaying(entry); }
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const year = yearOf(entry.video.published);
    groups.set(year, [...(groups.get(year) || []), entry]);
  }
  return <>
    <div className={styles.yearGroups}>
      {[...groups].map(([year, items]) => <section key={year} aria-label={`${year} ${tab}`}>
        <div className={styles.yearHeading}><h2>{year}</h2><span>{items.length} {tab} on this page</span></div>
        <div className={styles.videoCard}>{items.map((entry) => entry.snippet
          ? <button key={entry.key} className={`${styles.videoRow} ${styles.snippetRow}`} onClick={() => play(entry)}>
              <Thumbnail video={entry.video} clipDuration={duration(entry.snippet.durationMs)} />
              <span className={styles.videoInfo}><strong>{entry.snippet.title}</strong><span>{entry.video.channel} · {entry.video.title}</span></span>
              <span className={styles.date}>{displayDate(entry.video.published)}</span><span className={styles.playBadge}><Play size={12} fill="currentColor" />Play snippet</span>
            </button>
          : <VideoRow key={entry.key} video={entry.video} snippets={snippetsByVideo.get(entry.video.id) || []} onPlay={(snippet) => play({ ...entry, snippet })} />)}</div>
      </section>)}
    </div>
    <BrowsePagination page={page} totalPages={Math.ceil(total / PAGE_SIZE)} onChange={onPageChange} />
    <Dialog open={!!playing} onOpenChange={(open) => { if (!open) setPlaying(null); }}>
      <DialogContent className={styles.playerDialog}>
        <DialogTitle>{playing?.snippet?.title}</DialogTitle>
        <DialogDescription>{playing?.video.channel} · {playing && displayDate(playing.video.published)}</DialogDescription>
        {playing?.snippet && <video key={playing.snippet.id} controls autoPlay playsInline onError={() => setMediaError(true)} src={playing.snippet.url} className={styles.snippetPlayer} />}
        {mediaError && <p role="alert">This snippet could not be loaded. You can still open the full video below.</p>}
        {playing && <Link className={styles.outlineButton} href={`/video/${playing.video.id}`}>View full video<ChevronRight size={14} /></Link>}
      </DialogContent>
    </Dialog>
  </>;
}

function Thumbnail({ video, clipDuration }: { video: BrowseVideo; clipDuration?: string }) {
  return <span className={styles.thumbnail}><Image src={`https://img.youtube.com/vi/${video.id}/mqdefault.jpg`} alt="" width={120} height={68} />{(clipDuration || video.videoLength) && <span>{clipDuration || video.videoLength}</span>}</span>;
}
function VideoRow({ video, snippets, onPlay }: { video: BrowseVideo; snippets: BrowseSnippet[]; onPlay: (snippet: BrowseSnippet) => void }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <div className={styles.videoGroup}>
    <div className={styles.videoRow} data-expanded={expanded}>
      <Link className={styles.videoLink} href={`/video/${video.id}`}>
        <Thumbnail video={video} />
        <span className={styles.videoInfo}><strong>{video.title}</strong><span>{video.channel}</span></span>
        <span className={styles.date}>{displayDate(video.published)}</span>
      </Link>
      <button className={styles.snippetBadge} disabled={!snippets.length} aria-expanded={expanded} aria-controls={id} aria-label={`${expanded ? "Hide" : "Show"} ${snippets.length} snippets from ${video.title}`} onClick={() => setExpanded(!expanded)}><Scissors size={12} /><span>{snippets.length} {snippets.length === 1 ? "snippet" : "snippets"}</span>{!!snippets.length && <ChevronRight size={11} style={{ transform: expanded ? "rotate(90deg)" : undefined }} />}</button>
    </div>
    {expanded && <div id={id} className={styles.nestedSnippets}>
      <p>{snippets.length} {snippets.length === 1 ? "snippet" : "snippets"} from this video</p>
      <div>{snippets.map((snippet) => <button key={snippet.id} className={styles.nestedSnippet} onClick={() => onPlay(snippet)}><span className={styles.playDot}><Play size={10} fill="currentColor" /></span><span><strong>{snippet.title}</strong><small>{duration(snippet.durationMs)}</small></span></button>)}</div>
    </div>}
  </div>;
}
