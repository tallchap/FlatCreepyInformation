"use client";

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { WordTimestamp, CaptionStyle } from "./types";

interface Props {
  words: WordTimestamp[];
  style: CaptionStyle;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export const SnippyCaptions: React.FC<Props> = ({ words, style }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const scale = height / 1080;
  const nowSec = frame / fps;

  if (!words || words.length === 0) return null;

  const activeIdx = words.findIndex((w) => nowSec >= w.start && nowSec < w.end);

  let displayIdx = activeIdx;
  if (displayIdx === -1) {
    const upcoming = words.findIndex((w) => w.start > nowSec);
    displayIdx = upcoming === -1 ? words.length - 1 : Math.max(0, upcoming - 1);
  }

  const lineStart = Math.floor(displayIdx / style.wordsPerLine) * style.wordsPerLine;
  const lineWords = words.slice(lineStart, lineStart + style.wordsPerLine);

  const widthPct = Math.max(0.1, Math.min(1, style.widthPct));
  const leftPct = Math.max(0, Math.min(1 - widthPct, style.xPct - widthPct / 2));

  const bgStyle = style.bgEnabled
    ? {
        backgroundColor: hexToRgba(style.bgColor, style.bgOpacity / 100),
        padding: `${8 * scale}px ${18 * scale}px`,
        borderRadius: 12 * scale,
      }
    : {};

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: `${style.yPct * 100}%`,
          left: `${leftPct * 100}%`,
          width: `${widthPct * 100}%`,
          textAlign: "center",
          fontFamily: `'${style.fontFamily}', sans-serif`,
          fontSize: style.fontSize * scale,
          fontWeight: 900,
          letterSpacing: "0.02em",
          textTransform: "uppercase",
          WebkitTextStroke:
            style.strokeWidth > 0
              ? `${style.strokeWidth * scale}px ${style.strokeColor}`
              : "0",
          paintOrder: "stroke fill",
          textShadow: style.strokeWidth > 0
            ? `0 ${6 * scale}px ${18 * scale}px rgba(0,0,0,0.85)`
            : `0 ${4 * scale}px ${12 * scale}px rgba(0,0,0,0.9)`,
          transform: "translateY(-50%)",
        }}
      >
        <div style={{ display: "inline-block", ...bgStyle }}>
          {lineWords.map((w, i) => {
            const globalIdx = lineStart + i;
            const isActive = globalIdx === activeIdx;
            return (
              <span
                key={globalIdx}
                style={{
                  color: isActive ? style.activeColor : style.inactiveColor,
                  marginRight: "0.35em",
                  display: "inline-block",
                  transform: isActive ? "scale(1.08)" : "scale(1)",
                  transformOrigin: "bottom center",
                }}
              >
                {w.text}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
