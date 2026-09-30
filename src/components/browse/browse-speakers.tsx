"use client";

import { useEffect, useState } from "react";
import { getSpeakers } from "./utils/actions";
import type { Speaker } from "./utils/types";
import { SpeakerList } from "./speaker-list";

export function BrowseSpeakersContainer() {
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(false);
    getSpeakers().then((data) => { if (active) setSpeakers(data.speakers); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [attempt]);
  return <SpeakerList speakers={speakers} isLoading={isLoading} error={error} onRetry={() => setAttempt((n) => n + 1)} />;
}
