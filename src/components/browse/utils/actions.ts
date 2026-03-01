"use server";

import {
  fetchAllSpeakers,
  fetchSpeakerYears,
  fetchSpeakerYearMonths,
  fetchSpeakerMonthVideos,
} from "@/lib/bigquery";

export async function getSpeakers(page = 1) {
  return fetchAllSpeakers(page, 100);
}

export async function getSpeakerYears(speaker: string) {
  return fetchSpeakerYears(speaker);
}

export async function getSpeakerYearMonths(speaker: string, year: number) {
  return fetchSpeakerYearMonths(speaker, year);
}

export async function getSpeakerMonthVideos(
  speaker: string,
  year: number,
  month: number,
  page = 1,
) {
  return fetchSpeakerMonthVideos(speaker, year, month, page, 100);
}
