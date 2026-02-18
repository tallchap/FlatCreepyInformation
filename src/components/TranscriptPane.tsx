"use client";
import { useEffect, useRef, useState, useCallback } from "react";

type Line = { start: number; text: string };
type Paragraph = { start: number; lines: Line[] };
type ActivePos = { para: number; line: number } | null;
type Props = { videoId: string; height?: number; sentencesPerPara?: number; initialTimestamp?: number | null };

/** Find the paragraph + line matching a given timestamp. */
function findPositionForTime(paras: Paragraph[], t: number): ActivePos {
  const pIdx = paras.findIndex(
    (p, i) =>
      p.start <= t && (i + 1 === paras.length || paras[i + 1].start > t),
  );
  if (pIdx < 0) return null;
  const lines = paras[pIdx].lines;
  const lIdx = lines.findIndex(
    (l, i) =>
      l.start <= t && (i + 1 === lines.length || lines[i + 1].start > t),
  );
  return { para: pIdx, line: lIdx >= 0 ? lIdx : 0 };
}

export default function TranscriptPane({
  videoId,
  height = 300, // Reduced default height
  sentencesPerPara = 4, // Fewer sentences per paragraph
  initialTimestamp = null,
}: Props) {
  const [paras, setParas] = useState<Paragraph[]>([]);
  const [active, setActive] = useState<ActivePos>(null);
  const playerRef = useRef<any>(null);
  const activeLineRef = useRef<HTMLSpanElement | null>(null);
  const seekedAtRef = useRef<number>(0);
  const playerReadyRef = useRef<boolean>(false);
  const activeRef = useRef<ActivePos>(null);

  /* 1 ▸ FETCH & GROUP */
  useEffect(() => {
    fetch(`/api/transcript/${videoId}`)
      .then((r) => r.json())
      .then((lines: Line[]) => {
        const paragraphs: Paragraph[] = [];
        let cur: Paragraph | null = null;
        let sentCnt = 0;
        const sentEnd = /[.!?](?:\s|$)/g;

        for (const ln of lines) {
          if (!cur) {
            cur = { start: ln.start, lines: [] };
            sentCnt = 0;
          }
          cur.lines.push(ln);
          sentCnt += (ln.text.match(sentEnd) || []).length;

          if (sentCnt >= sentencesPerPara) {
            paragraphs.push(cur);
            cur = null;
          }
        }
        if (cur) paragraphs.push(cur);
        setParas(paragraphs);

        // Set initial scroll position from timestamp
        if (initialTimestamp != null && paragraphs.length > 0) {
          const pos = findPositionForTime(paragraphs, initialTimestamp);
          if (pos) {
            seekedAtRef.current = Date.now();
            setActive(pos);
          }
        }
      })
      .catch(console.error);
  }, [videoId, sentencesPerPara, initialTimestamp]);

  /* 2 ▸ PLAYER SETUP */
  useEffect(() => {
    const mountPlayer = () => {
      if (playerRef.current) return;
      const el = document.getElementById(`player-${videoId}`) as HTMLIFrameElement | null;
      if (el && (window as any).YT?.Player) {
        if (el.src && !el.src.includes('origin=')) {
          const sep = el.src.includes('?') ? '&' : '?';
          el.src = `${el.src}${sep}origin=${encodeURIComponent(window.location.origin)}`;
        }
        playerRef.current = new (window as any).YT.Player(el, {
          events: {
            onReady: () => { playerReadyRef.current = true; },
          },
        });
      }
    };
    if ((window as any).YT?.Player) {
      mountPlayer();
    } else {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(s);
      (window as any).onYouTubeIframeAPIReady = mountPlayer;
    }
  }, [videoId]);

  /* 3 ▸ SYNC & HIGHLIGHT */
  useEffect(() => {
    if (paras.length === 0) return;
    const timer = setInterval(() => {
      if (!playerReadyRef.current) return;
      if (Date.now() - seekedAtRef.current < 1000) return;
      const t = playerRef.current?.getCurrentTime?.();
      if (t == null) return;
      const pos = findPositionForTime(paras, t);
      if (!pos) return;
      if (!activeRef.current || activeRef.current.para !== pos.para || activeRef.current.line !== pos.line) {
        setActive(pos);
      }
    }, 300);
    return () => clearInterval(timer);
  }, [paras]);

  /* 3b ▸ SCROLL TO ACTIVE LINE */
  useEffect(() => {
    if (activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [active]);

  /* 3c ▸ KEEP ACTIVE REF IN SYNC */
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  /* 4 ▸ CLICK TO SEEK */
  const handleLineClick = (start: number, pIdx: number, lIdx: number) => {
    seekedAtRef.current = Date.now();
    if (playerReadyRef.current) {
      playerRef.current?.seekTo(start, true);
    }
    setActive({ para: pIdx, line: lIdx });
  };

  /* Ref callback for the active line */
  const activeRefCallback = useCallback((el: HTMLSpanElement | null) => {
    activeLineRef.current = el;
  }, []);

  /* 5 ▸ RENDER */
  return (
    <div
      className="overflow-y-auto text-m leading-tight space-y-2 bg-white dark:bg-gray-800 rounded-lg shadow p-3"
      style={{ maxHeight: height }}
    >
      {paras.map((p, pi) => (
        <p key={pi} className="mb-1">
          {p.lines.map((l, li) => {
            const isActive = active?.para === pi && active.line === li;
            return (
              <span
                key={li}
                ref={isActive ? activeRefCallback : undefined}
                onClick={() => handleLineClick(l.start, pi, li)}
                className={`cursor-pointer mr-1 ${
                  isActive ? "bg-blue-100 dark:bg-blue-600" : ""
                }`}
              >
                {l.text}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}
