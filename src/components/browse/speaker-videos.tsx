"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { getSpeakerVideos } from "./utils/actions";
import type { BrowseVideo } from "./utils/types";
import { VideoList } from "./video-list";

export function SpeakerVideosContainer({ speaker }: { speaker: string }) {
  const [isLoading, setIsLoading] = useState(true);
  const [videos, setVideos] = useState<BrowseVideo[]>([]);
  const [videosTotal, setVideosTotal] = useState(0);
  const [videoPage, setVideoPage] = useState(1);

  const loadVideos = useCallback(
    async (page: number) => {
      setIsLoading(true);
      try {
        const data = await getSpeakerVideos(speaker, page);
        setVideos(data.videos);
        setVideosTotal(data.total);
        setVideoPage(page);
      } finally {
        setIsLoading(false);
      }
    },
    [speaker],
  );

  useEffect(() => {
    loadVideos(1);
  }, [loadVideos]);

  return (
    <div className="space-y-4">
      {/* Breadcrumb + Back */}
      <div className="flex items-center gap-2">
        <Link href="/browse">
          <Button variant="ghost" size="sm">
            <ChevronLeft size={16} />
            Back
          </Button>
        </Link>
        <nav className="flex items-center gap-1 text-sm text-gray-500">
          <Link href="/browse" className="hover:text-gray-700 transition-colors">
            All Speakers
          </Link>
          <span className="mx-1">/</span>
          <span className="font-medium text-gray-800">{speaker}</span>
        </nav>
      </div>

      <VideoList
        speaker={speaker}
        videos={videos}
        total={videosTotal}
        page={videoPage}
        onPageChange={(p) => loadVideos(p)}
        isLoading={isLoading}
      />
    </div>
  );
}
