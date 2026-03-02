"use client";

import TranscriptPane from "@/components/TranscriptPane";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  videoId: string;
  startSec: number;
  title?: string;
};

export function VideoPreviewPane({ videoId, startSec, title }: Props) {
  const params = new URLSearchParams({
    start: String(startSec),
    autoplay: "1",
    enablejsapi: "1",
    cc_load_policy: "1",
    cc_lang_pref: "en",
    rel: "0",
    modestbranding: "1",
  });

  return (
    <Card className="xl:sticky xl:top-4 border-blue-200 shadow-sm h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Video preview</CardTitle>
        {title && <p className="text-xs text-gray-600 line-clamp-2">{title}</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="w-full aspect-video rounded-md overflow-hidden border">
          <iframe
            id={`player-${videoId}`}
            key={`${videoId}-${startSec}`}
            className="w-full h-full"
            src={`https://www.youtube.com/embed/${videoId}?${params.toString()}`}
            title={title ?? `Video preview ${videoId}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>

        <TranscriptPane
          videoId={videoId}
          height={340}
          sentencesPerPara={3}
          initialTimestamp={startSec}
          autoScrollToActive={false}
          playerSyncKey={`${videoId}-${startSec}`}
        />
      </CardContent>
    </Card>
  );
}
