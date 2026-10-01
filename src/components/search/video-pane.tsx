"use client";

import TranscriptPane from "@/components/TranscriptPane";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  videoId: string;
  startSec: number;
  snippetHtml?: string;
  videoTitle: string;
  channelName: string;
};

export function VideoPane({
  videoId,
  startSec,
  snippetHtml,
  videoTitle,
  channelName,
}: Props) {
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
    <Card className="xl:sticky xl:top-4 border-[#e6dfcc] shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Video preview</CardTitle>
          <a
            href={`/edit?v=${videoId}`}
            target="_blank"
            className="inline-flex items-center px-4 py-1.5 text-xs font-semibold text-white bg-[#DC2626] rounded-full transition-colors hover:bg-[#b91c1c]"
          >
            Snip It
          </a>
        </div>
        <p className="text-xs text-gray-600 line-clamp-2">{videoTitle}</p>
        <p className="text-xs text-gray-500">{channelName}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="w-full aspect-video rounded-md overflow-hidden border">
          <iframe
            id={`player-${videoId}`}
            key={`${videoId}-${startSec}`}
            className="w-full h-full"
            src={`https://www.youtube.com/embed/${videoId}?${params.toString()}`}
            title={`Video preview: ${videoTitle}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>

        {snippetHtml && (
          <div className="rounded-md border bg-gray-50 p-2 text-sm leading-relaxed">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
              Matched snippet
            </p>
            <div
              className="[&>mark]:bg-yellow-200 [&>mark]:font-semibold"
              dangerouslySetInnerHTML={{ __html: snippetHtml }}
            />
          </div>
        )}

        <TranscriptPane
          videoId={videoId}
          height={360}
          sentencesPerPara={3}
          initialTimestamp={startSec}
        />
      </CardContent>
    </Card>
  );
}
