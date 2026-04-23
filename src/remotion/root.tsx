import React from "react";
import { registerRoot, Composition } from "remotion";
import { SnippyComposition } from "../components/snippy/snippy-composition";
import { SnippyParityComposition } from "../components/snippy/snippy-parity-composition";
import type { SnippyCompositionProps } from "../components/snippy/types";

const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="SnippyComposition"
      component={SnippyComposition}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={300}
      defaultProps={{
        videoUrl: "",
        trimStartSec: 0,
        inSec: 0,
        outSec: 10,
        overlays: [],
        captions: [],
      } satisfies SnippyCompositionProps}
    />
    <Composition
      id="SnippyComposition720"
      component={SnippyComposition}
      width={1280}
      height={720}
      fps={30}
      durationInFrames={300}
      defaultProps={{
        videoUrl: "",
        trimStartSec: 0,
        inSec: 0,
        outSec: 10,
        overlays: [],
        captions: [],
      } satisfies SnippyCompositionProps}
    />
    <Composition
      id="SnippyParityComposition"
      component={SnippyParityComposition}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={300}
      defaultProps={{
        durationSec: 10,
        overlays: [],
        captions: [],
        bgColor: "#202020",
      }}
    />
  </>
);

registerRoot(RemotionRoot);
