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
  const [userScrolling, setUserScrolling] = useState(false);
  const userScrollTimeout = useRef<NodeJS.Timeout | null>(null);

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

  /* ─────────────────────────────────── 3 ▸ highlight & auto-scroll */
  useEffect(() => {
    if (!playerRef.current) return;

    const box = boxRef.current!;
    const scrollMargin = 40; // Renamed for clarity, was 'margin'

    const timer = setInterval(() => {
      const t = playerRef.current.getCurrentTime?.() ?? 0;

      /* ─ locate paragraph & line ─ */
      const pIdx = paras.findIndex(
        (p, i) =>
          p.start <= t && (i + 1 === paras.length || paras[i + 1].start > t),
      );
      if (pIdx < 0) return; // Current time is outside any paragraph range

      const linesInCurrentPara = paras[pIdx].lines;
      let lIdx = linesInCurrentPara.findIndex(
        (l, i) => l.start <= t && (i + 1 === linesInCurrentPara.length || linesInCurrentPara[i + 1].start > t),
      );

      // Handle cases where t might be within a paragraph's time but before the first explicitly timed line,
      // or if paragraph has no lines (though less likely for transcripts).
      if (lIdx < 0) {
        if (linesInCurrentPara.length > 0) {
          lIdx = 0; // Default to the first line of the paragraph for highlighting
        }
      }
      // Ensure lIdx for setActive is sensible e.g. 0 if pIdx is valid.
      const activeLineIdx = (lIdx >= 0 && lIdx < linesInCurrentPara.length) ? lIdx : 0;

      /* ─ update highlight only if position changed ─ */
      if (!active || active.para !== pIdx || active.line !== activeLineIdx) {
        setActive({ para: pIdx, line: activeLineIdx });

        /* ---------- Scroll to keep the active PARAGRAPH visible ---------- */
        if (!userScrolling) { // Only auto-scroll if user isn't manually scrolling
          const currentParaElement = box.children[pIdx] as HTMLElement;
          if (currentParaElement) {
            const paraTop = currentParaElement.offsetTop;
            const paraHeight = currentParaElement.offsetHeight;
            const paraBottom = paraTop + paraHeight;

            const viewTop = box.scrollTop + scrollMargin;
            const viewBottom = box.scrollTop + box.clientHeight - scrollMargin;

            if (paraTop < viewTop) {
              /* paragraph top is above or partially above viewport → scroll up just enough */
              box.scrollingProgrammatically = true; // Set flag to prevent triggering user scroll event
              box.scrollTo({
                top: Math.max(paraTop - scrollMargin, 0),
                behavior: "smooth",
              });
              // Reset the flag after animation
              setTimeout(() => {
                box.scrollingProgrammatically = false;
              }, 500);
            } else if (paraBottom > viewBottom) {
              /* paragraph bottom is below or partially below viewport → scroll down just enough */
              const maxScrollPossible = box.scrollHeight - box.clientHeight;
              // Calculate the scrollTop needed to bring the paragraph's bottom into view with margin
              const targetScrollTop = paraBottom - box.clientHeight + scrollMargin;
              box.scrollingProgrammatically = true; // Set flag to prevent triggering user scroll event
              box.scrollTo({
                top: Math.min(targetScrollTop, maxScrollPossible), // Ensure not to scroll beyond content
                behavior: "smooth",
              });
              // Reset the flag after animation
              setTimeout(() => {
                box.scrollingProgrammatically = false;
              }, 500);
            }
          }
        }
      }
    }, 250);

    return () => clearInterval(timer);
  }, [paras, active, videoId, userScrolling]); // Added videoId and userScrolling to dependencies

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
