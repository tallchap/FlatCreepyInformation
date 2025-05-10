"use client";
import { useEffect, useRef, useState } from "react";

type Line = { start: number; text: string };
type Paragraph = { start: number; lines: Line[] };
type ActivePos = { para: number; line: number } | null;
type Props = { videoId: string; height?: number; sentencesPerPara?: number };

// Extend HTMLDivElement to include our custom property
declare global {
  interface HTMLDivElement {
    scrollingProgrammatically?: boolean;
  }
}

export default function TranscriptPane({
  videoId,
  height = 400,
  sentencesPerPara = 3, // ← change if you prefer longer/shorter paragraphs
}: Props) {
  const [paras, setParas] = useState<Paragraph[]>([]);
  const [active, setActive] = useState<ActivePos>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);

  /* ─────────────────────────────────── 1 ▸ FETCH & GROUP  */
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
      })
      .catch(console.error);
  }, [videoId, sentencesPerPara]);

  /* ─────────────────────────────────── 2 ▸ PLAYER READY   */
  useEffect(() => {
    const mountPlayer = () => {
      if (playerRef.current) return;
      const el = document.getElementById(`player-${videoId}`);
      if (el && (window as any).YT?.Player) {
        playerRef.current = new (window as any).YT.Player(el);
      }
    };
    if ((window as any).YT?.Player) mountPlayer();
    else {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(s);
      (window as any).onYouTubeIframeAPIReady = mountPlayer;
    }
  }, [videoId]);

  /* ─────────────────────────────────── Handle user scroll */
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    let scrollTimeoutId: number | null = null;

    const handleScroll = () => {
      // We only consider it user scrolling if not triggered by our own scrollTo calls
      // This helps prevent false positives from smooth scrolling animations
      if (!box.scrollingProgrammatically) {
        setUserScrolling(true);

        // Reset the timer if it exists
        if (userScrollTimeout.current) {
          clearTimeout(userScrollTimeout.current);
        }

        // Set a new timer to reset userScrolling after scroll stops
        userScrollTimeout.current = setTimeout(() => {
          setUserScrolling(false);
        }, 2000); // 2 seconds before auto-scroll resumes
      }
    };

    // Throttle the scroll handler to improve performance
    const throttledHandleScroll = () => {
      if (scrollTimeoutId === null) {
        scrollTimeoutId = window.setTimeout(() => {
          handleScroll();
          scrollTimeoutId = null;
        }, 100); // 100ms throttle
      }
    };

    box.addEventListener("scroll", throttledHandleScroll);

    return () => {
      box.removeEventListener("scroll", throttledHandleScroll);
      if (userScrollTimeout.current) {
        clearTimeout(userScrollTimeout.current);
      }
      if (scrollTimeoutId !== null) {
        window.clearTimeout(scrollTimeoutId);
      }
    };
  }, []);

  /* ─────────────────────────────────── 3 ▸ highlight & minimal auto-scroll */
  useEffect(() => {
    if (!playerRef.current) return;

    const box = boxRef.current!;

    const timer = setInterval(() => {
      const t = playerRef.current.getCurrentTime?.() ?? 0;

      /* ─ locate paragraph & line ─ */
      const pIdx = paras.findIndex(
        (p, i) =>
          p.start <= t && (i + 1 === paras.length || paras[i + 1].start > t),
      );
      if (pIdx < 0) return;

      const lines = paras[pIdx].lines;
      const lIdx = lines.findIndex(
        (l, i) =>
          l.start <= t && (i + 1 === lines.length || lines[i + 1].start > t),
      );

      /* ─ update highlight only if position changed ─ */
      if (!active || active.para !== pIdx || active.line !== lIdx) {
        setActive({ para: pIdx, line: lIdx });

        // NO AUTO-SCROLLING DURING PLAYBACK
        // We'll only scroll when the user explicitly clicks on a transcript line
      }
    }, 250);

    return () => clearInterval(timer);
  }, [paras, active]);

  /* ─────────────────────────────────── Handle line clicks */
  const handleLineClick = (
    lineStart: number,
    paraIdx: number,
    lineIdx: number,
  ) => {
    // Temporarily prevent auto-scrolling when user clicks a line
    setUserScrolling(true);

    // Reset the timer if it exists
    if (userScrollTimeout.current) {
      clearTimeout(userScrollTimeout.current);
    }

    // Set a new timer to reset userScrolling after a delay
    userScrollTimeout.current = setTimeout(() => {
      setUserScrolling(false);
    }, 2000);

    // Seek to the timestamp
    playerRef.current?.seekTo(lineStart, true);

    // Update active highlight immediately without waiting for player time update
    setActive({ para: paraIdx, line: lineIdx });
  };

  /* ─────────────────────────────────── 4 ▸ RENDER         */
  return (
    <div
      ref={boxRef}
      className="overflow-y-auto text-[15px] leading-6 space-y-4 bg-white dark:bg-gray-800 rounded-xl shadow-md p-4"
      style={{ maxHeight: height }}
    >
      {paras.map((p, pi) => (
        <p key={pi} className="mb-0">
          {p.lines.map((l, li) => (
            <span
              key={li}
              onClick={() => handleLineClick(l.start, pi, li)}
              className={`cursor-pointer mr-1 ${
                active && active.para === pi && active.line === li
                  ? "bg-blue-200 dark:bg-blue-700"
                  : ""
              }`}
            >
              {l.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
