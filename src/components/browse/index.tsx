"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import {
  getSpeakers,
  getSpeakerVideos,
} from "./utils/actions";
import type {
  Speaker,
  BrowseVideo,
} from "./utils/types";
import { SpeakerList } from "./speaker-list";
import { VideoList } from "./video-list";

type View =
  | { level: "speakers" }
  | { level: "videos"; speaker: string };

export function BrowseContainer() {
  const [view, setView] = useState<View>({ level: "speakers" });
  const [isLoading, setIsLoading] = useState(false);

  // Speaker list state
  const [speakers, setSpeakers] = useState<Speaker[]>([]);

  // Video list state
  const [videos, setVideos] = useState<BrowseVideo[]>([]);
  const [videosTotal, setVideosTotal] = useState(0);
  const [videoPage, setVideoPage] = useState(1);

  // Load all speakers (large page to get them all for Finder grouping)
  const loadSpeakers = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getSpeakers(1, 5000);
      setSpeakers(data.speakers);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load videos for a speaker (20 per page)
  const loadVideos = useCallback(
    async (speaker: string, page: number) => {
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
    [],
  );

  // Initial load
  useEffect(() => {
    loadSpeakers();
  }, [loadSpeakers]);

  // Navigation handlers
  const selectSpeaker = (speaker: string) => {
    setView({ level: "videos", speaker });
    loadVideos(speaker, 1);
  };

  const goBack = () => {
    if (view.level === "videos") {
      setView({ level: "speakers" });
    }
  };

  // Breadcrumb
  const breadcrumb = () => {
    const parts: string[] = ["All Speakers"];
    if (view.level === "videos") {
      parts.push(view.speaker);
    }
    return parts;
  };

  return (
    <div className="space-y-4">
      {/* Breadcrumb + Back */}
      <div className="flex items-center gap-2">
        {view.level !== "speakers" && (
          <Button variant="ghost" size="sm" onClick={goBack}>
            <ChevronLeft size={16} />
            Back
          </Button>
        )}
        <nav className="flex items-center gap-1 text-sm text-gray-500">
          {breadcrumb().map((part, i, arr) => (
            <span key={i}>
              {i > 0 && <span className="mx-1">/</span>}
              <span
                className={
                  i === arr.length - 1
                    ? "font-medium text-gray-800"
                    : "text-gray-500"
                }
              >
                {part}
              </span>
            </span>
          ))}
        </nav>
      </div>

      {/* Views */}
      {view.level === "speakers" && (
        <SpeakerList
          speakers={speakers}
          onSelect={selectSpeaker}
          isLoading={isLoading}
        />
      )}

      {view.level === "videos" && (
        <VideoList
          speaker={view.speaker}
          videos={videos}
          total={videosTotal}
          page={videoPage}
          onPageChange={(p) => loadVideos(view.speaker, p)}
          isLoading={isLoading}
        />
      )}
    </div>
  );
}
