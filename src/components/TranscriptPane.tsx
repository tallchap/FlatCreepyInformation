"use client";
import { useEffect, useRef, useState } from "react";

type Line = { start: number; text: string };
type Paragraph = { start: number; lines: Line[] };
type ActivePos = { para: number; line: number } | null;
type Props = { videoId: string; height?: number; sentencesPerPara?: number };

export default function TranscriptPane({
  videoId,
  height = 300, // Reduced default height
  sentencesPerPara = 4, // Fewer sentences per paragraph
}: Props) {
  const [paras, setParas] = useState<Paragraph[]>([]);
  const [active, setActive] = useState<ActivePos>(null);
  const playerRef = useRef<any>(null);

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
      })
      .catch(console.error);
  }, [videoId, sentencesPerPara]);

  /* 2 ▸ PLAYER SETUP */
  useEffect(() => {
    const mountPlayer = () => {
      if (playerRef.current) return;
      const el = document.getElementById(`player-${videoId}`);
      if (el && (window as any).YT?.Player) {
        playerRef.current = new (window as any).YT.Player(el);
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
    if (!playerRef.current) return;
    const timer = setInterval(() => {
      const t = playerRef.current.getCurrentTime?.() ?? 0;
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
      const validLineIdx = lIdx >= 0 ? lIdx : 0;
      if (!active || active.para !== pIdx || active.line !== validLineIdx) {
        setActive({ para: pIdx, line: validLineIdx });
      }
    }, 300);
    return () => clearInterval(timer);
  }, [paras, active]);

  /* 4 ▸ CLICK TO SEEK */
  const handleLineClick = (start: number, pIdx: number, lIdx: number) => {
    playerRef.current?.seekTo(start, true);
    setActive({ para: pIdx, line: lIdx });
  };

  /* 5 ▸ RENDER */
  return (
    <div
      className="overflow-y-auto text-m leading-tight space-y-2 bg-white dark:bg-gray-800 rounded-lg shadow p-3"
      style={{ maxHeight: height }}
    >
      {paras.map((p, pi) => (
        <p key={pi} className="mb-1">
          {p.lines.map((l, li) => (
            <span
              key={li}
              onClick={() => handleLineClick(l.start, pi, li)}
              className={`cursor-pointer mr-1 ${
                active?.para === pi && active.line === li
                  ? "bg-blue-100 dark:bg-blue-600"
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
