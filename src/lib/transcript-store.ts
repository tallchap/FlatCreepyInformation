// src/lib/transcript-store.ts
// ─────────────────────────────────────────────────────────────
//  Atomic writes of one video's metadata + transcript segments.
//
//  The old path streamed rows in (`table.insert`) after a DELETE. BigQuery
//  refuses DML on rows still in the streaming buffer (~30 min), so a re-ingest
//  inside that window silently skipped the DELETE and stacked a second copy of
//  the transcript on top of the first (28 videos ended up with 2–7 copies).
//  DML-inserted rows have no streaming buffer, so every write here is one
//  multi-statement transaction: replace, assert the exact counts, commit — or
//  roll back and throw.
// ─────────────────────────────────────────────────────────────

import { BQ_PROJECT, BQ_DATASET } from "@/lib/bigquery-schema";

export interface TranscriptTables {
  videos: string;
  segments: string;
}

export const DEFAULT_TRANSCRIPT_TABLES: TranscriptTables = {
  videos: `${BQ_PROJECT}.${BQ_DATASET}.youtube_videos`,
  segments: `${BQ_PROJECT}.${BQ_DATASET}.youtube_transcript_segments`,
};

export interface VideoRow {
  video_id: string;
  video_title: string | null;
  channel_name: string | null;
  published_date: string | null; // YYYY-MM-DD
  youtube_link: string | null;
  video_length: string | null;
  speaker_source: string | null;
  created_time: string; // ISO timestamp
}

export interface SegmentRow {
  segment_id: string;
  segment_index: number;
  line_index: number;
  start_sec: number | null;
  end_sec: number | null;
  text: string;
}

const TABLE_ID = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

/** Segment rows exactly as the app has always shaped them, one per caption line. */
export function buildSegmentRows(videoId: string, transcriptData: any[]): SegmentRow[] {
  return transcriptData.map((segment: any, idx: number) => {
    const startSec = Number(segment.start ?? segment.Start ?? 0);
    const next = transcriptData[idx + 1];
    const nextStart = next ? Number(next.start ?? next.Start) : null;
    return {
      segment_id: `${videoId}:${String(idx).padStart(5, "0")}`,
      segment_index: idx,
      line_index: idx,
      start_sec: Number.isFinite(startSec) ? startSec : null,
      end_sec: nextStart !== null && Number.isFinite(nextStart) ? nextStart : null,
      text: String(segment.text ?? segment.Text ?? ""),
    };
  });
}

/**
 * One transaction: upsert the video row (columns written elsewhere, e.g.
 * vitrupo_score, survive), replace every segment, then assert exactly one
 * video row and exactly the new segment count before committing.
 */
export function replaceTranscriptSql(tables: TranscriptTables = DEFAULT_TRANSCRIPT_TABLES): string {
  for (const t of [tables.videos, tables.segments]) {
    if (!TABLE_ID.test(t)) throw new Error(`Invalid table identifier: ${t}`);
  }
  const V = `\`${tables.videos}\``;
  const S = `\`${tables.segments}\``;
  return `
BEGIN TRANSACTION;
MERGE ${V} T
USING (SELECT @video_id AS video_id) src
ON T.video_id = src.video_id
WHEN MATCHED THEN UPDATE SET
  video_title = @video_title,
  channel_name = @channel_name,
  published_date = SAFE_CAST(@published_date AS DATE),
  youtube_link = @youtube_link,
  video_length = @video_length,
  speaker_source = @speaker_source,
  created_time = TIMESTAMP(@created_time)
WHEN NOT MATCHED THEN INSERT
  (video_id, video_title, channel_name, published_date, youtube_link, video_length, speaker_source, created_time)
  VALUES (@video_id, @video_title, @channel_name, SAFE_CAST(@published_date AS DATE), @youtube_link,
          @video_length, @speaker_source, TIMESTAMP(@created_time));
DELETE FROM ${S} WHERE video_id = @video_id;
INSERT INTO ${S} (video_id, segment_id, segment_index, line_index, start_sec, end_sec, text, created_at)
SELECT @video_id, s.segment_id, s.segment_index, s.line_index, s.start_sec, s.end_sec, s.text, TIMESTAMP(@created_time)
FROM UNNEST(@segments) AS s;
ASSERT (SELECT COUNT(*) FROM ${V} WHERE video_id = @video_id) = 1
  AS 'expected exactly one youtube_videos row';
ASSERT (SELECT COUNT(*) FROM ${S} WHERE video_id = @video_id) = COALESCE(ARRAY_LENGTH(@segments), 0)
  AS 'segment count does not match the transcript';
COMMIT TRANSACTION;`;
}

export const REPLACE_TRANSCRIPT_TYPES = {
  video_id: "STRING",
  video_title: "STRING",
  channel_name: "STRING",
  published_date: "STRING",
  youtube_link: "STRING",
  video_length: "STRING",
  speaker_source: "STRING",
  created_time: "STRING",
  segments: [
    {
      segment_id: "STRING",
      segment_index: "INT64",
      line_index: "INT64",
      start_sec: "FLOAT64",
      end_sec: "FLOAT64",
      text: "STRING",
    },
  ],
} as const;

export async function replaceTranscript(
  bigQuery: { query: (opts: any) => Promise<any> },
  video: VideoRow,
  segments: SegmentRow[],
  tables: TranscriptTables = DEFAULT_TRANSCRIPT_TABLES,
): Promise<void> {
  await bigQuery.query({
    query: replaceTranscriptSql(tables),
    params: { ...video, segments },
    types: REPLACE_TRANSCRIPT_TYPES,
  });
}
