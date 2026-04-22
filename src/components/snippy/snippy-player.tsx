"use client";

import React, {
  useEffect,
  useRef,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from "react";
import { Player, type PlayerRef } from "@remotion/player";
import SnippyCompositionMemo from "./snippy-composition";
import { SnippyPlayerIframe } from "./snippy-player-iframe";
import type {
  OverlaySettings,
  WordTimestamp,
  CaptionStyle,
} from "./types";

const FPS = 30;

export interface SnippyPlayerHandle {
  seekTo: (sec: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  getCurrentTime: () => number;
  isPlaying: () => boolean;
  playRange: (startSec: number, endSec: number) => void;
}

interface SnippyPlayerProps {
  videoUrl: string;
  totalDuration: number;
  inSec: number | null;
  outSec: number | null;
  overlays?: OverlaySettings[];
  sourceCaptions?: WordTimestamp[];
  captionStyle?: CaptionStyle;
  onTimeUpdate?: (sec: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onDurationDetected?: (sec: number) => void;
}

function rebaseCaptions(
  captions: WordTimestamp[] | undefined,
  inSec: number | null,
  outSec: number | null
): WordTimestamp[] {
  if (!captions || inSec == null || outSec == null || outSec <= inSec) return [];
  return captions
    .filter((w) => w.end > inSec && w.start < outSec)
    .map((w) => ({
      text: w.text,
      start: Math.max(0, w.start - inSec),
      end: Math.max(0, Math.min(outSec, w.end) - inSec),
    }))
    .filter((w) => w.end > w.start && w.text.trim().length > 0);
}

const SnippyPlayer = forwardRef<SnippyPlayerHandle, SnippyPlayerProps>(
  (
    {
      videoUrl,
      totalDuration,
      inSec,
      outSec,
      overlays,
      sourceCaptions,
      captionStyle,
      onTimeUpdate,
      onPlayingChange,
      onDurationDetected,
    },
    ref
  ) => {
    const playerRef = useRef<PlayerRef>(null);
    const lastPlayingRef = useRef(false);
    const stopAtRef = useRef<number | null>(null);

    const durationInFrames = Math.max(1, Math.round((totalDuration || 1) * FPS));

    const clipCaptions = useMemo(
      () => rebaseCaptions(sourceCaptions, inSec, outSec),
      [sourceCaptions, inSec, outSec]
    );

    const effectiveIn = inSec ?? 0;
    const effectiveOut = outSec ?? totalDuration;

    const inputProps = useMemo(
      () => ({
        videoUrl,
        trimStartSec: 0,
        inSec: Math.max(0, Math.min(totalDuration, effectiveIn)),
        outSec: Math.max(
          Math.max(0, Math.min(totalDuration, effectiveIn)) + 0.01,
          Math.min(totalDuration, effectiveOut)
        ),
        overlays: overlays || [],
        captions: clipCaptions,
        captionStyle,
      }),
      [videoUrl, totalDuration, effectiveIn, effectiveOut, overlays, clipCaptions, captionStyle]
    );

    useImperativeHandle(ref, () => ({
      seekTo: (sec: number) => {
        stopAtRef.current = null;
        playerRef.current?.seekTo(Math.max(0, Math.round(sec * FPS)));
      },
      play: () => {
        stopAtRef.current = null;
        playerRef.current?.play();
      },
      pause: () => {
        stopAtRef.current = null;
        playerRef.current?.pause();
      },
      toggle: () => {
        stopAtRef.current = null;
        playerRef.current?.toggle();
      },
      getCurrentTime: () => {
        const frame = playerRef.current?.getCurrentFrame() ?? 0;
        return frame / FPS;
      },
      isPlaying: () => playerRef.current?.isPlaying() ?? false,
      playRange: (startSec: number, endSec: number) => {
        if (!playerRef.current) return;
        stopAtRef.current = endSec;
        playerRef.current.seekTo(Math.round(startSec * FPS));
        playerRef.current.play();
      },
    }));

    useEffect(() => {
      const interval = setInterval(() => {
        if (!playerRef.current) return;
        const frame = playerRef.current.getCurrentFrame() ?? 0;
        const sec = frame / FPS;
        onTimeUpdate?.(sec);

        const playing = playerRef.current.isPlaying();
        if (playing !== lastPlayingRef.current) {
          lastPlayingRef.current = playing;
          onPlayingChange?.(playing);
        }

        if (stopAtRef.current != null && playing && sec >= stopAtRef.current) {
          playerRef.current.pause();
          stopAtRef.current = null;
        }
      }, 100);
      return () => clearInterval(interval);
    }, [onTimeUpdate, onPlayingChange]);

    useEffect(() => {
      if (!videoUrl || !onDurationDetected) return;
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = videoUrl;
      v.onloadedmetadata = () => {
        onDurationDetected(v.duration);
        v.src = "";
      };
      return () => {
        v.src = "";
      };
    }, [videoUrl, onDurationDetected]);

    return (
      <SnippyPlayerIframe>
        <Player
          ref={playerRef}
          component={SnippyCompositionMemo}
          compositionWidth={1920}
          compositionHeight={1080}
          fps={FPS}
          durationInFrames={durationInFrames}
          inputProps={inputProps}
          style={{ width: "100%", height: "100%" }}
          controls
          allowFullscreen
        />
      </SnippyPlayerIframe>
    );
  }
);

SnippyPlayer.displayName = "SnippyPlayer";

export { SnippyPlayer };
