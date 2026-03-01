"use client";

import { useMemo } from "react";
import { BrowseVideo } from "./utils/types";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import Image from "next/image";

export function VideoList({
  speaker,
  videos,
  total,
  page,
  onPageChange,
  isLoading,
}: {
  speaker: string;
  videos: BrowseVideo[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  isLoading: boolean;
}) {
  const totalPages = Math.ceil(total / 20);

  // Group videos by year from published date
  const groupedByYear = useMemo(() => {
    const groups: { year: string; videos: BrowseVideo[] }[] = [];
    let currentYear = "";
    for (const video of videos) {
      const year = video.published.substring(0, 4);
      if (year !== currentYear) {
        currentYear = year;
        groups.push({ year, videos: [] });
      }
      groups[groups.length - 1].videos.push(video);
    }
    return groups;
  }, [videos]);

  if (isLoading) {
    return (
      <div className="text-center py-8 text-gray-500">Loading videos...</div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider px-1">
        <span className="text-blue-700 normal-case">{speaker}</span>
        <span className="font-normal text-gray-400 normal-case ml-2">
          ({total} {total === 1 ? "video" : "videos"})
        </span>
      </h2>

      {groupedByYear.map((group) => (
        <div key={group.year} className="space-y-3">
          <h3 className="text-lg font-semibold text-gray-700 border-b border-gray-200 pb-1">
            {group.year}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {group.videos.map((video) => (
              <Link
                key={video.id}
                href={`/video/${video.id}`}
                className="group block"
              >
                <div className="rounded-lg overflow-hidden border border-gray-200 bg-white hover:border-blue-300 hover:shadow-md transition-all">
                  <Image
                    src={`https://img.youtube.com/vi/${video.id}/mqdefault.jpg`}
                    alt={video.title}
                    width={320}
                    height={180}
                    className="w-full aspect-video object-cover"
                  />
                  <div className="p-2.5">
                    <p className="text-xs font-medium text-gray-800 line-clamp-2 group-hover:text-blue-700 transition-colors">
                      {video.title}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-1 truncate">
                      {video.channel}
                    </p>
                    <p className="text-[11px] text-gray-400 truncate">
                      {video.published}
                      {video.videoLength && ` · ${video.videoLength}`}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}

      {videos.length === 0 && (
        <p className="text-center text-gray-500 py-4">
          No videos found.
        </p>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft size={16} />
            Previous
          </Button>
          <span className="text-sm text-gray-600">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
            <ChevronRight size={16} />
          </Button>
        </div>
      )}
    </div>
  );
}
