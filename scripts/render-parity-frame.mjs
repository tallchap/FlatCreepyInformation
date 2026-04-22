// Local parity render: produce a single frame of SnippyParityComposition via the
// same Remotion bundle+renderer the Lambda uses. Output is a PNG that can be
// pixel-diffed against a preview-iframe screenshot driven by the same inputProps.
//
// Solid bg (no video) so the test isolates overlay+caption parity from
// video-decoding variance.
//
// Usage: node scripts/render-parity-frame.mjs

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DURATION_SEC = 3;
const FPS = 30;
const SNAPSHOT_FRAME = 30; // 1s in

const inputProps = {
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

const outPath = path.resolve(
  ROOT,
  "qa-recordings/snippy-parity-2026-04-22/render-frame.png"
);

console.log("Bundling composition...");
const bundled = await bundle({
  entryPoint: path.resolve(ROOT, "src/remotion/root.tsx"),
  outDir: path.join(os.tmpdir(), "snippy-parity-bundle"),
  webpackOverride: (config) => {
    config.cache = false;
    return config;
  },
});
console.log("Bundle:", bundled);

const composition = await selectComposition({
  serveUrl: bundled,
  id: "SnippyParityComposition",
  inputProps,
});
composition.durationInFrames = Math.max(1, Math.round(DURATION_SEC * FPS));

console.log(
  `Rendering still at frame ${SNAPSHOT_FRAME} of ${composition.durationInFrames}...`
);

await renderStill({
  composition,
  serveUrl: bundled,
  frame: SNAPSHOT_FRAME,
  output: outPath,
  inputProps,
  imageFormat: "png",
});

console.log(`Wrote ${outPath}`);
console.log(JSON.stringify({ inputProps, frame: SNAPSHOT_FRAME, fps: FPS }, null, 2));
