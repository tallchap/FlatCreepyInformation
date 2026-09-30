"use server";

import { bigQuery, fetchSpeakerVideos } from "@/lib/bigquery";
import { TABLE_REFS, useNewTranscriptTables } from "@/lib/bigquery-schema";
import { playableMediaUrl } from "./presentation";
import type { Speaker, SpeakerLibrary } from "./types";

// Keep the Browse queries local: other pages retain their existing data contracts.
function catalogSql() {
  return useNewTranscriptTables()
    ? `SELECT video_id, video_title, channel_name, published_date, youtube_link,
              video_length, speaker_source, created_time FROM ${TABLE_REFS.videos}`
    : `SELECT ID AS video_id, Video_Title AS video_title, Channel_Name AS channel_name,
              Published_Date AS published_date, Youtube_Link AS youtube_link,
              Video_Length AS video_length,
              COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS speaker_source,
              Created_Time AS created_time FROM ${TABLE_REFS.legacyTranscripts}`;
}

export async function getSpeakers(): Promise<{ speakers: Speaker[]; total: number }> {
  const [rows] = await bigQuery.query({
    query: `WITH catalog AS (${catalogSql()})
      SELECT TRIM(speaker) AS name, COUNT(DISTINCT video_id) AS videoCount,
             CAST(MAX(created_time) AS STRING) AS updatedAt
      FROM catalog, UNNEST(SPLIT(speaker_source, ',')) AS speaker
      WHERE TRIM(speaker) != '' GROUP BY name ORDER BY name`,
  });
  const speakers = rows.map((r: { name: string; videoCount: number; updatedAt: string | null }) => ({
    name: String(r.name), videoCount: Number(r.videoCount), updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  }));
  return { speakers, total: speakers.length };
}

export async function getSpeakerLibrary(speaker: string): Promise<SpeakerLibrary> {
  if (!speaker.trim()) return { videos: [], snippets: [] };
  const [rows] = await bigQuery.query({
    query: `WITH catalog AS (${catalogSql()})
      SELECT video_id, video_title, channel_name, CAST(published_date AS STRING) AS published,
             youtube_link, video_length, speaker_source
      FROM catalog
      WHERE EXISTS (SELECT 1 FROM UNNEST(SPLIT(speaker_source, ',')) AS name
                    WHERE LOWER(TRIM(name)) = LOWER(@speaker))
      QUALIFY ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY created_time DESC) = 1
      ORDER BY published_date DESC, video_id`,
    params: { speaker },
  });
  const videos = rows.map((r: { video_id: string; video_title: string; channel_name: string; published: string; speaker_source: string; youtube_link: string; video_length: string | null }) => ({
    id: String(r.video_id), title: String(r.video_title || "Untitled video"),
    channel: String(r.channel_name || ""), published: String(r.published || ""),
    speakers: String(r.speaker_source || ""), youtubeUrl: String(r.youtube_link || ""),
    videoLength: r.video_length ? String(r.video_length) : null,
  }));
  if (!videos.length) return { videos, snippets: [] };
  const [snippets] = await bigQuery.query({
    query: `SELECT CONCAT('clip:', CAST(clip_id AS STRING)) AS id, video_id, title, duration_ms, gcs_url
      FROM \`youtubetranscripts-429803.reptranscripts.clips\`
      WHERE video_id IN UNNEST(@videoIds) AND gcs_url IS NOT NULL AND gcs_url != ''
      UNION ALL
      SELECT CONCAT('auto:', snippet_id) AS id, original_video_id AS video_id, title, duration_ms, gcs_url
      FROM \`youtubetranscripts-429803.reptranscripts.snippets_auto\`
      WHERE original_video_id IN UNNEST(@videoIds) AND gcs_url IS NOT NULL AND gcs_url != ''`,
    params: { videoIds: videos.map((v: { id: string }) => v.id) },
  });
  const seen = new Set<string>();
  return {
    videos,
    snippets: snippets.filter((r: { video_id: string; gcs_url: string }) => {
      const url = playableMediaUrl(String(r.gcs_url));
      if (!url) return false;
      const key = `${r.video_id}:${url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((r: { id: string; video_id: string; title: string; duration_ms: number; gcs_url: string }) => ({
      id: String(r.id), videoId: String(r.video_id), title: String(r.title || "Untitled snippet"),
      durationMs: Number(r.duration_ms) || 0, url: playableMediaUrl(String(r.gcs_url))!,
    })),
  };
}

export async function getSpeakerVideos(speaker: string, page = 1) {
  return fetchSpeakerVideos(speaker, page, 20);
}
