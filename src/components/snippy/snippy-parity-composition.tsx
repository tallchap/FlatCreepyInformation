"use client";

import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { OverlaySettings, WordTimestamp, CaptionStyle } from "./types";
import { SnippyCaptions } from "./snippy-captions";
import "./snippy-fonts";

const RESET_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; line-height: 1.5; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
`;

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function OverlayLayer({ overlay }: { overlay: OverlaySettings }) {
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: `${overlay.xPct * 100}%`,
          top: `${overlay.yPct * 100}%`,
          transform: "translate(0, -100%)",
          maxWidth: `${(1 - overlay.xPct) * 100}%`,
          fontSize: overlay.fontSize,
          fontWeight: 700,
          fontFamily: `'${overlay.fontFamily}', sans-serif`,
          lineHeight: 1.2,
          color: overlay.color,
          opacity: overlay.opacity / 100,
          backgroundColor: overlay.bgBox
            ? hexToRgba(overlay.bgColor, overlay.bgOpacity / 100)
            : undefined,
          padding: overlay.bgBox ? "4px 8px" : undefined,
          borderRadius: overlay.bgBox ? 4 : undefined,
          textShadow: !overlay.bgBox ? "1px 1px 4px rgba(0,0,0,0.9)" : undefined,
          whiteSpace: "pre-wrap",
        }}
      >
        {overlay.text}
      </div>
    </AbsoluteFill>
  );
}

export interface SnippyParityCompositionProps {
  durationSec: number;
  overlays?: OverlaySettings[];
  captions?: WordTimestamp[];
  captionStyle?: CaptionStyle;
  bgColor?: string;
}

const SnippyParityComposition: React.FC<SnippyParityCompositionProps> = ({
  durationSec,
  overlays,
  captions,
  captionStyle,
  bgColor = "#202020",
}) => {
  const { fps } = useVideoConfig();
  const durationInFrames = Math.max(1, Math.round(durationSec * fps));

  return (
    <AbsoluteFill style={{ background: bgColor }}>
      <style>{RESET_CSS}</style>
      <Sequence from={0} durationInFrames={durationInFrames} layout="none">
        {(overlays || []).map((overlay) => {
          if (!overlay.text) return null;
          const start = Math.max(0, overlay.startSec);
          const end = Math.min(durationSec, overlay.endSec);
          if (end <= start) return null;
          const fromFrame = Math.round(start * fps);
          const inFrames = Math.max(1, Math.round((end - start) * fps));
          return (
            <Sequence
              key={overlay.id}
              from={fromFrame}
              durationInFrames={inFrames}
              layout="none"
            >
              <OverlayLayer overlay={overlay} />
            </Sequence>
          );
        })}
        {captions && captionStyle && captions.length > 0 && (
          <SnippyCaptions words={captions} style={captionStyle} />
        )}
      </Sequence>
    </AbsoluteFill>
  );
};

export default React.memo(SnippyParityComposition);
export { SnippyParityComposition };
