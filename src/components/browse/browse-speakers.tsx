"use client";

import { useCallback, useEffect, useState } from "react";
import { getSpeakers } from "./utils/actions";
import type { Speaker } from "./utils/types";
import { SpeakerList } from "./speaker-list";

export function BrowseSpeakersContainer() {
  const [isLoading, setIsLoading] = useState(true);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);

  const loadSpeakers = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getSpeakers(1, 5000);
      setSpeakers(data.speakers);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSpeakers();
  }, [loadSpeakers]);

  return (
    <SpeakerList
      speakers={speakers}
      isLoading={isLoading}
    />
  );
}
