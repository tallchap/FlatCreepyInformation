"use server";

import {
  fetchAllSpeakers,
  fetchSpeakerVideos,
} from "@/lib/bigquery";

export async function getSpeakers(page = 1, pageSize = 100) {
  return fetchAllSpeakers(page, pageSize);
}

export async function getSpeakerVideos(speaker: string, page = 1) {
  return fetchSpeakerVideos(speaker, page, 20);
}
