"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import {
  getSpeakers,
  getSpeakerYears,
  getSpeakerYearVideos,
} from "./utils/actions";
import type {
  Speaker,
  YearEntry,
  BrowseVideo,
} from "./utils/types";
import { SpeakerList } from "./speaker-list";
import { YearView } from "./year-view";
import { VideoList } from "./video-list";

type View =
  | { level: "speakers" }
  | { level: "years"; speaker: string }
  | { level: "videos"; speaker: string; year: number };

export function BrowseContainer() {
  const [view, setView] = useState<View>({ level: "speakers" });
  const [isLoading, setIsLoading] = useState(false);

  // Speaker list state
  const [speakers, setSpeakers] = useState<Speaker[]>([]);

  // Year view state
  const [years, setYears] = useState<YearEntry[]>([]);

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

  // Load years for a speaker
  const loadYears = useCallback(async (speaker: string) => {
    setIsLoading(true);
    try {
      const data = await getSpeakerYears(speaker);
      setYears(data);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load videos for a speaker + year
  const loadVideos = useCallback(
    async (speaker: string, year: number, page: number) => {
      setIsLoading(true);
      try {
        const data = await getSpeakerYearVideos(speaker, year, page);
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
    setView({ level: "years", speaker });
    loadYears(speaker);
  };

  const selectYear = (year: number) => {
    if (view.level === "years") {
      setView({ level: "videos", speaker: view.speaker, year });
      loadVideos(view.speaker, year, 1);
    }
  };

  const goBack = () => {
    switch (view.level) {
      case "years":
        setView({ level: "speakers" });
        break;
      case "videos":
        setView({ level: "years", speaker: view.speaker });
        loadYears(view.speaker);
        break;
    }
  };

  // Breadcrumb
  const breadcrumb = () => {
    const parts: string[] = ["All Speakers"];
    if (view.level !== "speakers") {
      parts.push(view.speaker);
    }
    if (view.level === "videos") {
      parts.push(String(view.year));
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

      {view.level === "years" && (
        <YearView
          speaker={view.speaker}
          years={years}
          onSelect={selectYear}
          isLoading={isLoading}
        />
      )}

      {view.level === "videos" && (
        <VideoList
          speaker={view.speaker}
          year={view.year}
          videos={videos}
          total={videosTotal}
          page={videoPage}
          onPageChange={(p) =>
            loadVideos(view.speaker, view.year, p)
          }
          isLoading={isLoading}
        />
      )}
    </div>
  );
}
