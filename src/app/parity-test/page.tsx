"use client";

import { useRef } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { SnippyPlayerIframe } from "@/components/snippy/snippy-player-iframe";
import { SnippyParityComposition } from "@/components/snippy/snippy-parity-composition";

const FPS = 30;
const DURATION_SEC = 3;
const SNAPSHOT_FRAME = 30;

const INPUT_PROPS = {
  durationSec: DURATION_SEC,
  bgColor: "#202020",
  overlays: [
    {
      id: "ov1",
      text: "PARITY TEST",
      xPct: 0.05,
      yPct: 0.12,
      fontSize: 96,
      fontFamily: "Montserrat",
      color: "#ffffff",
      opacity: 100,
      bgBox: true,
      bgColor: "#1d1917",
      bgOpacity: 80,
      startSec: 0,
      endSec: DURATION_SEC,
    },
    {
      id: "ov2",
      text: "BOTTOM RIGHT",
      xPct: 0.55,
      yPct: 0.92,
      fontSize: 64,
      fontFamily: "Bebas Neue",
      color: "#D97757",
      opacity: 100,
      bgBox: false,
      bgColor: "#000000",
      bgOpacity: 0,
      startSec: 0,
      endSec: DURATION_SEC,
    },
  ],
  captions: [
    { text: "HELLO", start: 0.2, end: 0.8 },
    { text: "WORLD", start: 0.9, end: 1.6 },
    { text: "PARITY", start: 1.7, end: 2.4 },
    { text: "CONFIRMED", start: 2.5, end: 2.95 },
  ],
  captionStyle: {
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
  },
};

export default function ParityTestPage() {
  const playerRef = useRef<PlayerRef>(null);

  const seekToSnapshot = () => {
    playerRef.current?.seekTo(SNAPSHOT_FRAME);
    playerRef.current?.pause();
  };

  return (
    <div style={{ maxWidth: 1200, margin: "2rem auto", fontFamily: "system-ui" }}>
      <h1 style={{ marginBottom: 8 }}>Snippy Parity Test</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 16 }}>
        Preview iframe (below) renders the same composition + inputProps as{" "}
        <code>scripts/render-parity-frame.mjs</code>. Pause at frame{" "}
        {SNAPSHOT_FRAME} ({(SNAPSHOT_FRAME / FPS).toFixed(2)}s) and compare
        against <code>render-frame.png</code>.
      </p>
      <div style={{ border: "1px solid #ccc", borderRadius: 8, overflow: "hidden" }}>
        <SnippyPlayerIframe>
          <Player
            ref={playerRef}
            component={SnippyParityComposition}
            compositionWidth={1920}
            compositionHeight={1080}
            fps={FPS}
            durationInFrames={DURATION_SEC * FPS}
            inputProps={INPUT_PROPS}
            style={{ width: "100%", height: "100%" }}
            controls
          />
        </SnippyPlayerIframe>
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button
          onClick={seekToSnapshot}
          style={{
            padding: "8px 16px",
            background: "#D97757",
            color: "#fff",
            border: 0,
            borderRadius: 4,
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          Seek to snapshot frame
        </button>
      </div>
    </div>
  );
}
