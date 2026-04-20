"use client";

import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, useVideoConfig } from "remotion";
import type { SnippyCompositionProps, OverlaySettings } from "./types";
import { SnippyCaptions } from "./snippy-captions";

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
          fontSize: overlay.fontSize,
          fontWeight: 700,
          fontFamily: `'${overlay.fontFamily}', sans-serif`,
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

const SnippyComposition: React.FC<SnippyCompositionProps> = ({
  videoUrl,
  trimStartSec,
  inSec,
  outSec,
  overlays,
  captions,
  captionStyle,
}) => {
  const { fps } = useVideoConfig();
  const clipDurationSec = Math.max(0.01, outSec - inSec);
  const clipFromFrame = Math.round(inSec * fps);
  const clipDurationInFrames = Math.max(1, Math.round(clipDurationSec * fps));

  return (
    <AbsoluteFill>
      <OffthreadVideo
        src={videoUrl}
        startFrom={Math.round(trimStartSec * fps)}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />

      <Sequence from={clipFromFrame} durationInFrames={clipDurationInFrames} layout="none">
        {(overlays || []).map((overlay) => {
          if (!overlay.text) return null;
          const clamped = {
            start: Math.max(0, overlay.startSec),
            end: Math.min(clipDurationSec, overlay.endSec),
          };
          if (clamped.end <= clamped.start) return null;
          const fromFrame = Math.round(clamped.start * fps);
          const durationInFrames = Math.max(
            1,
            Math.round((clamped.end - clamped.start) * fps)
          );
          return (
            <Sequence
              key={overlay.id}
              from={fromFrame}
              durationInFrames={durationInFrames}
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

export default React.memo(SnippyComposition);
export { SnippyComposition };
