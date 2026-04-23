"use client";

import { useRef } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { SnippyPlayerIframe } from "@/components/snippy/snippy-player-iframe";
import { SnippyComposition } from "@/components/snippy/snippy-composition";

const FPS = 30;

// MUST stay in sync with qa-recordings/snippy-smoke-2026-04-22/inputs.json —
// keep literal so preview + render see byte-identical overlays/captions.
const RAW_VIDEO_URL =
  "https://vz-27263f38-8d7.b-cdn.net/3050ea05-b096-4e3c-91d5-96688bd3795b/play_1080p.mp4";
const START_SEC = 5;
const END_SEC = 8;

const OVERLAYS = [
  {
    id: "tl",
    text: "TL",
    anchor: "top-left" as const,
    xPct: 0,
    yPct: 0,
    fontSize: 120,
    fontFamily: "Montserrat",
    color: "#ffffff",
    opacity: 100,
    bgBox: true,
    bgColor: "#ff00ff",
    bgOpacity: 100,
    startSec: 0,
    endSec: 3,
  },
  {
    id: "br",
    text: "BR",
    anchor: "bottom-right" as const,
    xPct: 1,
    yPct: 1,
    fontSize: 120,
    fontFamily: "Montserrat",
    color: "#ffffff",
    opacity: 100,
    bgBox: true,
    bgColor: "#00ffff",
    bgOpacity: 100,
    startSec: 0,
    endSec: 3,
  },
];

const CAPTION_STYLE = {
  fontFamily: "Anton",
  fontSize: 72,
  activeColor: "#D97757",
  inactiveColor: "#FFFFFF",
  strokeColor: "#000000",
  strokeWidth: 6,
  xPct: 0.5,
  yPct: 0.82,
  widthPct: 0.84,
  wordsPerLine: 4,
  bgEnabled: false,
  bgColor: "#000000",
  bgOpacity: 70,
};

export default function SnippySmokePage() {
  const playerRef = useRef<PlayerRef>(null);

  const clipDurationSec = END_SEC - START_SEC;
  const durationInFrames = Math.max(1, Math.round(clipDurationSec * FPS));
  const proxiedVideoUrl = `/api/bunny-proxy?src=${encodeURIComponent(RAW_VIDEO_URL)}`;

  const compositionProps = {
    videoUrl: proxiedVideoUrl,
    trimStartSec: START_SEC,
    inSec: 0,
    outSec: clipDurationSec,
    overlays: OVERLAYS,
    captions: [],
    captionStyle: CAPTION_STYLE,
  };

  const seekToFrame = (frame: number) => {
    playerRef.current?.seekTo(frame);
    playerRef.current?.pause();
  };

  return (
    <div style={{ margin: 0, padding: 0, fontFamily: "system-ui" }}>
      <div
        id="smoke-iframe-wrapper"
        style={{ width: 1920, height: 1080, margin: 0, padding: 0 }}
      >
        <SnippyPlayerIframe
          style={{ width: 1920, height: 1080, aspectRatio: "auto", borderRadius: 0 }}
        >
          <Player
            ref={playerRef}
            component={SnippyComposition as never}
            compositionWidth={1920}
            compositionHeight={1080}
            fps={FPS}
            durationInFrames={durationInFrames}
            inputProps={compositionProps as never}
            style={{ width: "100%", height: "100%" }}
          />
        </SnippyPlayerIframe>
      </div>
      <div style={{ padding: 12, display: "flex", gap: 8 }}>
        <button onClick={() => seekToFrame(45)} style={btn}>seek 45 (1.5s)</button>
        <button onClick={() => seekToFrame(0)} style={btn}>seek 0</button>
        <button onClick={() => playerRef.current?.play()} style={btn}>play</button>
        <button onClick={() => playerRef.current?.pause()} style={btn}>pause</button>
      </div>
    </div>
  );
}

const btn = {
  padding: "8px 16px",
  background: "#D97757",
  color: "#fff",
  border: 0,
  borderRadius: 4,
  cursor: "pointer",
  fontWeight: 500,
} as const;
