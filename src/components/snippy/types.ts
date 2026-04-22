export interface OverlaySettings {
  id: string;
  text: string;
  xPct: number;
  yPct: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  opacity: number;
  bgBox: boolean;
  bgColor: string;
  bgOpacity: number;
  startSec: number;
  endSec: number;
}

export interface WordTimestamp {
  text: string;
  start: number;
  end: number;
}

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  activeColor: string;
  inactiveColor: string;
  strokeColor: string;
  strokeWidth: number;
  xPct: number;
  yPct: number;
  widthPct: number;
  wordsPerLine: number;
  bgEnabled: boolean;
  bgColor: string;
  bgOpacity: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
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

export interface SnippyCompositionProps {
  videoUrl: string;
  trimStartSec: number;
  inSec: number;
  outSec: number;
  overlays?: OverlaySettings[];
  captions?: WordTimestamp[];
  captionStyle?: CaptionStyle;
}

export interface BunnyVideo {
  guid: string;
  title: string;
  length: number;
  width: number;
  height: number;
  status: number;
  encodeProgress: number;
  availableResolutions: string;
  thumbnailFileName: string;
  dateUploaded: string;
}
