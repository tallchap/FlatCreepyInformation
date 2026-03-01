"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import {
  getSpeakers,
  getSpeakerYears,
  getSpeakerYearMonths,
  getSpeakerMonthVideos,
} from "./utils/actions";
import type {
  Speaker,
  YearEntry,
  MonthEntry,
  BrowseVideo,
} from "./utils/types";
import { SpeakerList } from "./speaker-list";
import { YearView } from "./year-view";
import { MonthView } from "./month-view";
import { VideoList } from "./video-list";

type View =
  | { level: "speakers" }
  | { level: "years"; speaker: string }
  | { level: "months"; speaker: string; year: number }
  | { level: "videos"; speaker: string; year: number; month: number };

export function BrowseContainer() {
  const [view, setView] = useState<View>({ level: "speakers" });
  const [isLoading, setIsLoading] = useState(false);

  // Speaker list state
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [speakersTotal, setSpeakersTotal] = useState(0);
  const [speakerPage, setSpeakerPage] = useState(1);

  // Year view state
  const [years, setYears] = useState<YearEntry[]>([]);

  // Month view state
  const [months, setMonths] = useState<MonthEntry[]>([]);

  // Video list state
  const [videos, setVideos] = useState<BrowseVideo[]>([]);
  const [videosTotal, setVideosTotal] = useState(0);
  const [videoPage, setVideoPage] = useState(1);

  // Load speakers
  const loadSpeakers = useCallback(async (page: number) => {
    setIsLoading(true);
    try {
      const data = await getSpeakers(page);
      setSpeakers(data.speakers);
      setSpeakersTotal(data.total);
      setSpeakerPage(page);
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

  // Load months for a speaker + year
  const loadMonths = useCallback(async (speaker: string, year: number) => {
    setIsLoading(true);
    try {
      const data = await getSpeakerYearMonths(speaker, year);
      setMonths(data);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load videos for a speaker + year + month
  const loadVideos = useCallback(
    async (speaker: string, year: number, month: number, page: number) => {
      setIsLoading(true);
      try {
        const data = await getSpeakerMonthVideos(speaker, year, month, page);
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
    loadSpeakers(1);
  }, [loadSpeakers]);

  // Navigation handlers
  const selectSpeaker = (speaker: string) => {
    setView({ level: "years", speaker });
    loadYears(speaker);
  };

  const selectYear = (year: number) => {
    if (view.level === "years" || view.level === "months") {
      setView({ level: "months", speaker: view.speaker, year });
      loadMonths(view.speaker, year);
    }
  };

  const selectMonth = (month: number) => {
    if (view.level === "months") {
      setView({
        level: "videos",
        speaker: view.speaker,
        year: view.year,
        month,
      });
      loadVideos(view.speaker, view.year, month, 1);
    }
  };

  const goBack = () => {
    switch (view.level) {
      case "years":
        setView({ level: "speakers" });
        break;
      case "months":
        setView({ level: "years", speaker: view.speaker });
        loadYears(view.speaker);
        break;
      case "videos":
        setView({
          level: "months",
          speaker: view.speaker,
          year: view.year,
        });
        loadMonths(view.speaker, view.year);
        break;
    }
  };

  // Breadcrumb
  const breadcrumb = () => {
    const parts: string[] = ["All Speakers"];
    if (view.level !== "speakers") {
      parts.push(view.speaker);
    }
    if (view.level === "months" || view.level === "videos") {
      parts.push(String(view.year));
    }
    if (view.level === "videos") {
      const monthNames = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      parts.push(monthNames[view.month - 1]);
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
          total={speakersTotal}
          page={speakerPage}
          onPageChange={(p) => loadSpeakers(p)}
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

      {view.level === "months" && (
        <MonthView
          speaker={view.speaker}
          year={view.year}
          months={months}
          onSelect={selectMonth}
          isLoading={isLoading}
        />
      )}

      {view.level === "videos" && (
        <VideoList
          speaker={view.speaker}
          year={view.year}
          month={view.month}
          videos={videos}
          total={videosTotal}
          page={videoPage}
          onPageChange={(p) =>
            loadVideos(view.speaker, view.year, view.month, p)
          }
          isLoading={isLoading}
        />
      )}
    </div>
  );
}
