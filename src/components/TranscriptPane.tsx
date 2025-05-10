
"use client";
import { useEffect, useRef, useState } from "react";

type Line       = { start: number; text: string };
type Paragraph  = { start: number; lines: Line[] };
type ActivePos  = { para: number; line: number } | null;
type Props      = { videoId: string; height?: number; sentencesPerPara?: number };

export default function TranscriptPane({
  videoId,
  height = 400,
  sentencesPerPara = 3,          // ← change if you prefer longer/shorter paragraphs
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
      .then(r => r.json())
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

  /* ─────────────────────────────────── 3 ▸ SYNC HIGHLIGHT */
  useEffect(() => {
    if (!playerRef.current) return;
    const box = boxRef.current!;
    const scrollMargin = 40;
    
    const timer = setInterval(() => {
      const t = playerRef.current.getCurrentTime?.() ?? 0;

      // locate paragraph
      const pIdx = paras.findIndex(
        (p, i) => p.start <= t && (i + 1 === paras.length || paras[i + 1].start > t),
      );
      if (pIdx < 0) return;

      // locate line inside paragraph
      const lines = paras[pIdx].lines;
      const lIdx = lines.findIndex(
        (l, i) => l.start <= t && (i + 1 === lines.length || lines[i + 1].start > t),
      );
      
      // Ensure we have a valid line index
      const validLineIdx = lIdx >= 0 ? lIdx : 0;

      if (!active || active.para !== pIdx || active.line !== validLineIdx) {
        setActive({ para: pIdx, line: validLineIdx });

        // Only auto-scroll if user isn't manually scrolling
        if (!userScrolling && box.children[pIdx]) {
          const paraEl = box.children[pIdx] as HTMLElement;
          const paraTop = paraEl.offsetTop;
          const paraHeight = paraEl.offsetHeight;
          const paraBottom = paraTop + paraHeight;
          
          const viewTop = box.scrollTop + scrollMargin;
          const viewBottom = box.scrollTop + box.clientHeight - scrollMargin;
          
          if (paraTop < viewTop) {
            // Paragraph is above viewport - scroll up
            box.scrollingProgrammatically = true;
            box.scrollTo({
              top: Math.max(paraTop - scrollMargin, 0),
              behavior: "smooth",
            });
          } else if (paraBottom > viewBottom) {
            // Paragraph is below viewport - scroll down
            const maxScrollPossible = box.scrollHeight - box.clientHeight;
            const targetScrollTop = paraBottom - box.clientHeight + scrollMargin;
            box.scrollingProgrammatically = true;
            box.scrollTo({
              top: Math.min(targetScrollTop, maxScrollPossible),
              behavior: "smooth",
            });
          }
          
          // Reset the flag after animation
          setTimeout(() => {
            box.scrollingProgrammatically = false;
          }, 500);
        }
      }
    }, 250);
    return () => clearInterval(timer);
  }, [paras, active, userScrolling]);

  /* ─────────────────────────────────── Handle line clicks */
  const handleLineClick = (
    lineStart: number,
    paraIdx: number,
    lineIdx: number,
  ) => {
    setUserScrolling(true);
    if (userScrollTimeout.current) {
      clearTimeout(userScrollTimeout.current);
    }
    userScrollTimeout.current = setTimeout(() => {
      setUserScrolling(false);
    }, 2000); // Consider a slightly shorter timeout if 2s feels too long

    playerRef.current?.seekTo(lineStart, true);
    setActive({ para: paraIdx, line: lineIdx });

    // --- Add direct scroll logic here ---
    if (boxRef.current) {
      const box = boxRef.current;
      // Ensure DOM has updated if setActive causes a re-render that affects children
      requestAnimationFrame(() => {
        const targetParaElement = box.children[paraIdx] as HTMLElement;
        if (targetParaElement) {
          const scrollMargin = 40; // Consistent margin

          const paraTop = targetParaElement.offsetTop;
          const paraHeight = targetParaElement.offsetHeight;
          const paraBottom = paraTop + paraHeight;

          const viewTop = box.scrollTop + scrollMargin;
          const viewBottom = box.scrollTop + box.clientHeight - scrollMargin;

          box.scrollingProgrammatically = true; // Set flag

          if (paraTop < viewTop) {
            box.scrollTo({
              top: Math.max(paraTop - scrollMargin, 0),
              behavior: "smooth",
            });
          } else if (paraBottom > viewBottom) {
            const maxScrollPossible = box.scrollHeight - box.clientHeight;
            const destScrollTop = paraBottom - box.clientHeight + scrollMargin;
            box.scrollTo({
              top: Math.min(destScrollTop, maxScrollPossible),
              behavior: "smooth",
            });
          }
          // Reset the flag after animation
          setTimeout(() => {
            box.scrollingProgrammatically = false;
          }, 500);
        }
      });
    }
  };

  /* ─────────────────────────────────── 4 ▸ RENDER         */
  return (
    <div
      ref={boxRef}
      className="overflow-y-auto text-[15px] leading-6 space-y-4 bg-white dark:bg-gray-800 rounded-xl shadow-md p-4"
      style={{ maxHeight: height }}
      onScroll={() => {
        if (!boxRef.current?.scrollingProgrammatically) {
          setUserScrolling(true);
          if (userScrollTimeout.current) {
            clearTimeout(userScrollTimeout.current);
          }
          userScrollTimeout.current = setTimeout(() => {
            setUserScrolling(false);
          }, 2000);
        }
      }}
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
