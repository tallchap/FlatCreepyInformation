"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { getSpeakerVideos } from "./utils/actions";
import type { BrowseVideo } from "./utils/types";
import { VideoList } from "./video-list";

export function SpeakerVideosContainer({ speaker }: { speaker: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const initialPage = Math.max(1, Number(searchParams.get("page")) || 1);

  const [isLoading, setIsLoading] = useState(true);
  const [videos, setVideos] = useState<BrowseVideo[]>([]);
  const [videosTotal, setVideosTotal] = useState(0);
  const [videoPage, setVideoPage] = useState(initialPage);

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

  const handlePageChange = useCallback(
    (page: number) => {
      setVideoPage(page);
      const params = new URLSearchParams(searchParams.toString());
      if (page === 1) {
        params.delete("page");
      } else {
        params.set("page", String(page));
      }
      const query = params.toString();
      router.push(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
      loadVideos(page);
    },
    [searchParams, router, pathname, loadVideos],
  );

  useEffect(() => {
    loadVideos(initialPage);
  }, [loadVideos, initialPage]);

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
        onPageChange={handlePageChange}
        isLoading={isLoading}
      />
    </div>
  );
}
