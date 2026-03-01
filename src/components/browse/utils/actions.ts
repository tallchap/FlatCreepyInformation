"use server";

import {
  fetchAllSpeakers,
  fetchSpeakerYears,
  fetchSpeakerYearVideos,
} from "@/lib/bigquery";

export async function getSpeakers(page = 1, pageSize = 100) {
  return fetchAllSpeakers(page, pageSize);
}

export async function getSpeakerYears(speaker: string) {
  return fetchSpeakerYears(speaker);
}

export async function getSpeakerYearVideos(
  speaker: string,
  year: number,
  page = 1,
) {
  return fetchSpeakerYearVideos(speaker, year, page, 100);
}
