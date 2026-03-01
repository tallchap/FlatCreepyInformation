"use client";

import { BrowseVideo } from "./utils/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, ChevronLeft, ChevronRight, Youtube } from "lucide-react";
import Link from "next/link";
import Image from "next/image";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function VideoList({
  speaker,
  year,
  month,
  videos,
  total,
  page,
  onPageChange,
  isLoading,
}: {
  speaker: string;
  year: number;
  month: number;
  videos: BrowseVideo[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  isLoading: boolean;
}) {
  const totalPages = Math.ceil(total / 100);

  if (isLoading) {
    return (
      <div className="text-center py-8 text-gray-500">Loading videos...</div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-700">
        <span className="text-blue-700">{speaker}</span> &mdash;{" "}
        {MONTH_NAMES[month - 1]} {year}
        <span className="text-sm font-normal text-gray-500 ml-2">
          ({total} {total === 1 ? "video" : "videos"})
        </span>
      </h2>

      <div className="space-y-3">
        {videos.map((video) => (
          <Card key={video.id} className="hover:border-blue-200 transition-all">
            <CardContent className="flex flex-col sm:flex-row gap-4 py-4">
              {/* YouTube thumbnail */}
              <Link
                href={`/video/${video.id}`}
                className="flex-shrink-0 block"
              >
                <Image
                  src={`https://img.youtube.com/vi/${video.id}/mqdefault.jpg`}
                  alt={video.title}
                  width={320}
                  height={180}
                  className="rounded-lg w-full sm:w-[200px] object-cover"
                />
              </Link>

              {/* Video info */}
              <div className="flex flex-col gap-1 min-w-0">
                <Link
                  href={`/video/${video.id}`}
                  className="text-base font-medium text-blue-800 hover:underline line-clamp-2"
                >
                  {video.title}
                </Link>
                <div className="flex flex-wrap gap-3 text-sm text-gray-500">
                  <span className="flex items-center gap-1">
                    <Youtube size={14} />
                    {video.channel}
                  </span>
                  <span className="flex items-center gap-1">
                    <Calendar size={14} />
                    {video.published}
                  </span>
                  {video.videoLength && (
                    <span className="text-gray-400">{video.videoLength}</span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mt-1">
                  <span className="font-medium">Speakers:</span>{" "}
                  {video.speakers}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {videos.length === 0 && (
        <p className="text-center text-gray-500 py-4">
          No videos found for this period.
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
