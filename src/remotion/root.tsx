import React from "react";
import { registerRoot, Composition } from "remotion";
import { SnippyComposition } from "../components/snippy/snippy-composition";
import type { SnippyCompositionProps } from "../components/snippy/types";

const RemotionRoot: React.FC = () => (
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
);

registerRoot(RemotionRoot);
