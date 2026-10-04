"use client";

import Link from "next/link";
import type { Ref } from "react";
import TranscriptPane from "@/components/TranscriptPane";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  videoId: string;
  startSec: number;
  title?: string;
  /** Changes on every citation tap, so re-tapping a link re-cues the player. */
  cueId?: number;
  previewRef?: Ref<HTMLDivElement>;
  onClose?: () => void;
};

export function VideoPreviewPane({ videoId, startSec, title, cueId = 0, previewRef, onClose }: Props) {
  const params = new URLSearchParams({
    start: String(startSec),
    autoplay: "1",
    enablejsapi: "1",
    cc_load_policy: "1",
    cc_lang_pref: "en",
    rel: "0",
    modestbranding: "1",
    // Without this iPhones hand the video to the native fullscreen player.
    playsinline: "1",
  });
  // Set origin up front so the IFrame API never has to rewrite src (which
  // reloads the player after the tap that opened it).
  if (typeof window !== "undefined") params.set("origin", window.location.origin);
  const playerKey = `${videoId}-${startSec}-${cueId}`;

  return (
    <Card ref={previewRef} tabIndex={-1} aria-label="Video preview" className="xl:sticky xl:top-4 scroll-mt-4 border-[#e6dfcc] shadow-none h-fit focus:outline-none">
      <CardHeader className="px-4 sm:px-6 pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Video preview</CardTitle>
          {onClose && (
            <button onClick={onClose} className="min-h-11 shrink-0 rounded-lg px-2 text-xs text-[#1f2e25] hover:bg-[#f5ecd2] focus-visible:outline-2">
              Back to chat
            </button>
          )}
        </div>
        {title && <p className="text-xs text-gray-600 line-clamp-2">{title}</p>}
      </CardHeader>
      <CardContent className="px-4 sm:px-6 space-y-3">
        <div className="w-full aspect-video rounded-md overflow-hidden border">
          <iframe
            id={`player-${videoId}`}
            key={playerKey}
            className="w-full h-full"
            src={`https://www.youtube.com/embed/${videoId}?${params.toString()}`}
            title={title ?? `Video preview ${videoId}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>

        <div className="min-h-[240px]">
          <TranscriptPane
            videoId={videoId}
            height={240}
            sentencesPerPara={3}
            initialTimestamp={startSec}
            autoScrollToActive
            playerSyncKey={playerKey}
          />
        </div>

        <div className="pt-2 border-t border-[#e6dfcc]">
          <Link
            href={`/edit?v=${videoId}`}
            target="_blank"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-[#DC2626] rounded-full transition-colors hover:bg-[#b91c1c]"
          >
            Snip It
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
