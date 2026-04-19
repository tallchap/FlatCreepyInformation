// src/lib/bigquery.ts
import { BigQuery } from "@google-cloud/bigquery";
import { TABLE_REFS, useNewTranscriptTables } from "@/lib/bigquery-schema";

function parseServiceAccount(raw: string | undefined) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const fixed = raw.replace(
      /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
      (_m, key) =>
        `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
    );
    return JSON.parse(fixed);
  }
}

const credentials = parseServiceAccount(
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
);

export const bigQuery =
  (global as any).bigQuery ??
  new BigQuery({ credentials, projectId: credentials.project_id });

if (process.env.NODE_ENV !== "production") {
  (global as any).bigQuery = bigQuery;
}

const LEGACY_TABLE = TABLE_REFS.legacyTranscripts;
const VIDEOS_TABLE = TABLE_REFS.videos;
const SEGMENTS_TABLE = TABLE_REFS.transcriptSegments;

const LEGACY_SPEAKERS_EXPR = `COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude)`;

function parseLegacyTranscript(raw: string): { start: number | null; text: string }[] {
  const out: { start: number | null; text: string }[] = [];

  raw
    .trim()
    .split(/\n+/)
    .forEach((ln) => {
      let m = ln.match(/^\[(\d+):(\d{2})(?::(\d{2}))?]\s*(.*)$/);
      if (m) {
        const [, a, b, c, txt] = m;
        const sec = c ? +a * 3600 + +b * 60 + +c : +a * 60 + +b;
        out.push({ start: sec, text: txt });
        return;
      }

      m = ln.match(/^(\d+(?:\.\d+)?):\s*(.*)$/);
      if (m) {
        out.push({ start: parseFloat(m[1]), text: m[2] });
        return;
      }

      if (ln.trim()) out.push({ start: null, text: ln.trim() });
    });

  out.sort((a, b) => {
    if (a.start === null) return 1;
    if (b.start === null) return -1;
    return a.start - b.start;
  });

  return out;
}

export async function fetchVideoMeta(id: string) {
  if (useNewTranscriptTables()) {
    const [rows] = await bigQuery.query({
      query: `
        SELECT
          v.video_title AS title,
          v.channel_name AS channel,
          v.published_date AS published,
          v.video_length AS video_length,
          v.youtube_link AS youtube_url,
          v.speaker_source AS speakers,
          d.description
        FROM ${VIDEOS_TABLE} v
        LEFT JOIN \`youtubetranscripts-429803.reptranscripts.video_descriptions\` d
          ON v.video_id = d.video_id
        WHERE v.video_id = @id
        LIMIT 1
      `,
      params: { id },
    });

    if (rows[0]) return rows[0] as any;
  }

  const [rows] = await bigQuery.query({
    query: `
      SELECT
        Video_Title AS title,
        Channel_Name AS channel,
        Published_Date AS published,
        Video_Length AS video_length,
        CONCAT('https://youtu.be/', ID) AS youtube_url,
        ${LEGACY_SPEAKERS_EXPR} AS speakers
      FROM ${LEGACY_TABLE}
      WHERE ID = @id
      LIMIT 1
    `,
    params: { id },
  });

  return rows[0] as
    | {
        title: string;
        channel: string;
        published: string | Date;
        video_length: string | null;
        youtube_url: string;
        speakers: string | null;
      }
    | undefined;
}

export async function fetchSpeakerVideosBeforeDate(
  speaker: string,
  beforeDate: string,
  limit = 200,
): Promise<{ id: string; title: string; publishedAt: string }[]> {
  if (useNewTranscriptTables()) {
    const [rows] = await bigQuery.query({
      query: `
        SELECT
          video_id AS id,
          video_title AS title,
          CAST(published_date AS STRING) AS publishedAt
        FROM ${VIDEOS_TABLE}
        WHERE speaker_source IS NOT NULL
          AND LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%')
          AND published_date IS NOT NULL
          AND published_date < DATE(@beforeDate)
        ORDER BY published_date DESC
        LIMIT @limit
      `,
      params: { speaker, beforeDate, limit },
    });

    return rows.map((r: any) => ({
      id: String(r.id),
      title: String(r.title),
      publishedAt: String(r.publishedAt),
    }));
  }

  const [rows] = await bigQuery.query({
    query: `
      SELECT ID AS id, Video_Title AS title, CAST(Published_Date AS STRING) AS publishedAt
      FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s
      WHERE TRIM(s) = @speaker
        AND Published_Date IS NOT NULL
        AND Published_Date < DATE(@beforeDate)
      ORDER BY Published_Date DESC
      LIMIT @limit
    `,
    params: { speaker, beforeDate, limit },
  });

  return rows.map((r: any) => ({
    id: String(r.id),
    title: String(r.title),
    publishedAt: String(r.publishedAt),
  }));
}

async function speakerCountQuery(query: string, params: Record<string, unknown> = {}) {
  const [rows] = await bigQuery.query({ query, params });
  return rows;
}

export async function fetchAllSpeakers(page = 1, pageSize = 100) {
  const offset = (page - 1) * pageSize;

  if (useNewTranscriptTables()) {
    const [countRows] = await bigQuery.query({
      query: `SELECT COUNT(DISTINCT TRIM(speaker)) AS total FROM ${VIDEOS_TABLE}, UNNEST(SPLIT(speaker_source, ',')) AS speaker WHERE TRIM(speaker) != ''`,
    });
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await bigQuery.query({
      query: `
        SELECT TRIM(speaker) AS name, COUNT(DISTINCT video_id) AS videoCount
        FROM ${VIDEOS_TABLE}, UNNEST(SPLIT(speaker_source, ',')) AS speaker
        WHERE TRIM(speaker) != ''
        GROUP BY name
        ORDER BY name ASC
        LIMIT @pageSize OFFSET @offset
      `,
      params: { pageSize, offset },
    });

    return { speakers: rows.map((r: any) => ({ name: r.name, videoCount: Number(r.videoCount) })), total };
  }

  const [countRows] = await bigQuery.query({
    query: `SELECT COUNT(DISTINCT TRIM(speaker)) AS total FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS speaker WHERE TRIM(speaker) != ''`,
  });
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await bigQuery.query({
    query: `
      SELECT TRIM(speaker) AS name, COUNT(DISTINCT ID) AS videoCount
      FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS speaker
      WHERE TRIM(speaker) != ''
      GROUP BY name
      ORDER BY name ASC
      LIMIT @pageSize OFFSET @offset
    `,
    params: { pageSize, offset },
  });

  return { speakers: rows.map((r: any) => ({ name: r.name, videoCount: Number(r.videoCount) })), total };
}

export async function fetchSpeakerYears(speaker: string) {
  const query = useNewTranscriptTables()
    ? `SELECT EXTRACT(YEAR FROM published_date) AS year, COUNT(DISTINCT video_id) AS videoCount FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%') GROUP BY year ORDER BY year DESC`
    : `SELECT EXTRACT(YEAR FROM Published_Date) AS year, COUNT(DISTINCT ID) AS videoCount FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s WHERE TRIM(s) = @speaker GROUP BY year ORDER BY year DESC`;

  const rows = await speakerCountQuery(query, { speaker });
  return rows.map((r: any) => ({ year: Number(r.year), videoCount: Number(r.videoCount) }));
}

export async function fetchSpeakerYearMonths(speaker: string, year: number) {
  const query = useNewTranscriptTables()
    ? `SELECT EXTRACT(MONTH FROM published_date) AS month, COUNT(DISTINCT video_id) AS videoCount FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%') AND EXTRACT(YEAR FROM published_date) = @year GROUP BY month ORDER BY month ASC`
    : `SELECT EXTRACT(MONTH FROM Published_Date) AS month, COUNT(DISTINCT ID) AS videoCount FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s WHERE TRIM(s) = @speaker AND EXTRACT(YEAR FROM Published_Date) = @year GROUP BY month ORDER BY month ASC`;

  const rows = await speakerCountQuery(query, { speaker, year });
  return rows.map((r: any) => ({ month: Number(r.month), videoCount: Number(r.videoCount) }));
}

function mapSpeakerVideos(rows: any[]) {
  return rows.map((r: any) => ({
    id: String(r.id),
    title: String(r.title),
    channel: String(r.channel),
    published: String(r.published),
    speakers: String(r.speakers ?? ""),
    youtubeUrl: String(r.youtubeUrl),
    videoLength: r.videoLength ? String(r.videoLength) : null,
  }));
}

export async function fetchSpeakerMonthVideos(speaker: string, year: number, month: number, page = 1, pageSize = 100) {
  const offset = (page - 1) * pageSize;

  const countQuery = useNewTranscriptTables()
    ? `SELECT COUNT(DISTINCT video_id) AS total FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%') AND EXTRACT(YEAR FROM published_date)=@year AND EXTRACT(MONTH FROM published_date)=@month`
    : `SELECT COUNT(DISTINCT ID) AS total FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s WHERE TRIM(s)=@speaker AND EXTRACT(YEAR FROM Published_Date)=@year AND EXTRACT(MONTH FROM Published_Date)=@month`;

  const dataQuery = useNewTranscriptTables()
    ? `SELECT DISTINCT video_id AS id, video_title AS title, channel_name AS channel, CAST(published_date AS STRING) AS published, speaker_source AS speakers, youtube_link AS youtubeUrl, video_length AS videoLength FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%') AND EXTRACT(YEAR FROM published_date)=@year AND EXTRACT(MONTH FROM published_date)=@month ORDER BY published DESC LIMIT @pageSize OFFSET @offset`
    : `SELECT DISTINCT ID AS id, Video_Title AS title, Channel_Name AS channel, CAST(Published_Date AS STRING) AS published, ${LEGACY_SPEAKERS_EXPR} AS speakers, CONCAT('https://youtu.be/', ID) AS youtubeUrl, Video_Length AS videoLength FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s WHERE TRIM(s)=@speaker AND EXTRACT(YEAR FROM Published_Date)=@year AND EXTRACT(MONTH FROM Published_Date)=@month ORDER BY published DESC LIMIT @pageSize OFFSET @offset`;

  const [countRows] = await bigQuery.query({ query: countQuery, params: { speaker, year, month } });
  const [rows] = await bigQuery.query({ query: dataQuery, params: { speaker, year, month, pageSize, offset } });

  return { videos: mapSpeakerVideos(rows), total: Number(countRows[0]?.total ?? 0) };
}

export async function fetchSpeakerVideos(speaker: string, page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize;
  const countQuery = useNewTranscriptTables()
    ? `SELECT COUNT(DISTINCT video_id) AS total FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%')`
    : `SELECT COUNT(DISTINCT ID) AS total FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s WHERE TRIM(s)=@speaker`;
  const dataQuery = useNewTranscriptTables()
    ? `SELECT DISTINCT video_id AS id, video_title AS title, channel_name AS channel, CAST(published_date AS STRING) AS published, speaker_source AS speakers, youtube_link AS youtubeUrl, video_length AS videoLength FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%') ORDER BY published DESC LIMIT @pageSize OFFSET @offset`
    : `SELECT DISTINCT ID AS id, Video_Title AS title, Channel_Name AS channel, CAST(Published_Date AS STRING) AS published, ${LEGACY_SPEAKERS_EXPR} AS speakers, CONCAT('https://youtu.be/', ID) AS youtubeUrl, Video_Length AS videoLength FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s WHERE TRIM(s)=@speaker ORDER BY published DESC LIMIT @pageSize OFFSET @offset`;

  const [countRows] = await bigQuery.query({ query: countQuery, params: { speaker } });
  const [rows] = await bigQuery.query({ query: dataQuery, params: { speaker, pageSize, offset } });
  return { videos: mapSpeakerVideos(rows), total: Number(countRows[0]?.total ?? 0) };
}

export async function fetchSpeakerYearVideos(speaker: string, year: number, page = 1, pageSize = 100) {
  const offset = (page - 1) * pageSize;
  const countQuery = useNewTranscriptTables()
    ? `SELECT COUNT(DISTINCT video_id) AS total FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%') AND EXTRACT(YEAR FROM published_date)=@year`
    : `SELECT COUNT(DISTINCT ID) AS total FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s WHERE TRIM(s)=@speaker AND EXTRACT(YEAR FROM Published_Date)=@year`;
  const dataQuery = useNewTranscriptTables()
    ? `SELECT DISTINCT video_id AS id, video_title AS title, channel_name AS channel, CAST(published_date AS STRING) AS published, speaker_source AS speakers, youtube_link AS youtubeUrl, video_length AS videoLength FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE CONCAT('%', LOWER(@speaker), '%') AND EXTRACT(YEAR FROM published_date)=@year ORDER BY published DESC LIMIT @pageSize OFFSET @offset`
    : `SELECT DISTINCT ID AS id, Video_Title AS title, Channel_Name AS channel, CAST(Published_Date AS STRING) AS published, ${LEGACY_SPEAKERS_EXPR} AS speakers, CONCAT('https://youtu.be/', ID) AS youtubeUrl, Video_Length AS videoLength FROM ${LEGACY_TABLE}, UNNEST(SPLIT(${LEGACY_SPEAKERS_EXPR}, ',')) AS s WHERE TRIM(s)=@speaker AND EXTRACT(YEAR FROM Published_Date)=@year ORDER BY published DESC LIMIT @pageSize OFFSET @offset`;

  const [countRows] = await bigQuery.query({ query: countQuery, params: { speaker, year } });
  const [rows] = await bigQuery.query({ query: dataQuery, params: { speaker, year, pageSize, offset } });

  return { videos: mapSpeakerVideos(rows), total: Number(countRows[0]?.total ?? 0) };
}

// ── Speaker filter context (cached per speaker for GPT pre-pass) ──────

export interface SpeakerFilterContext {
  channels: string[];
  coSpeakers: string[];
  years: number[];
}

const filterContextCache = new Map<string, SpeakerFilterContext>();

export async function fetchSpeakerFilterContext(speakerName: string): Promise<SpeakerFilterContext> {
  if (filterContextCache.has(speakerName)) return filterContextCache.get(speakerName)!;

  const speakerLike = `%${speakerName}%`;

  const [channelRows, speakerRows, yearRows] = await Promise.all([
    bigQuery.query({
      query: `SELECT DISTINCT channel_name FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE LOWER(@speakerLike) AND channel_name IS NOT NULL`,
      params: { speakerLike },
    }),
    bigQuery.query({
      query: `SELECT DISTINCT TRIM(s) AS name FROM ${VIDEOS_TABLE}, UNNEST(SPLIT(speaker_source, ',')) AS s WHERE LOWER(speaker_source) LIKE LOWER(@speakerLike) AND TRIM(s) != ''`,
      params: { speakerLike },
    }),
    bigQuery.query({
      query: `SELECT DISTINCT EXTRACT(YEAR FROM published_date) AS y FROM ${VIDEOS_TABLE} WHERE LOWER(speaker_source) LIKE LOWER(@speakerLike) AND published_date IS NOT NULL ORDER BY y`,
      params: { speakerLike },
    }),
  ]);

  const ctx: SpeakerFilterContext = {
    channels: channelRows[0].map((r: any) => String(r.channel_name)).filter(Boolean),
    coSpeakers: speakerRows[0].map((r: any) => String(r.name)).filter(Boolean).filter((name: string) => name.toLowerCase() !== speakerName.toLowerCase()),
    years: yearRows[0].map((r: any) => Number(r.y)).filter(Boolean),
  };

  filterContextCache.set(speakerName, ctx);
  return ctx;
}

export async function fetchTranscript(id: string) {
  if (useNewTranscriptTables()) {
    const [rows] = await bigQuery.query({
      query: `
        SELECT DISTINCT start_sec, text
        FROM ${SEGMENTS_TABLE}
        WHERE video_id = @id
        ORDER BY COALESCE(start_sec, 1e12)
      `,
      params: { id },
    });

    if (rows?.length) {
      return rows.map((r: any) => ({
        start: r.start_sec === null || r.start_sec === undefined ? null : Number(r.start_sec),
        text: String(r.text ?? ""),
      }));
    }
  }

  const [rows] = await bigQuery.query({
    query: `SELECT Search_Doc_1 FROM ${LEGACY_TABLE} WHERE ID = @id LIMIT 1`,
    params: { id },
  });

  if (!rows?.length || !rows[0].Search_Doc_1) return [];
  return parseLegacyTranscript(rows[0].Search_Doc_1 as string);
}

/* ── Clips ── */

import type { Clip, AutoSnippet } from "@/lib/types/clip";

const CLIPS_TABLE = "youtubetranscripts-429803.reptranscripts.clips";
const SNIPPETS_AUTO_TABLE = "youtubetranscripts-429803.reptranscripts.snippets_auto";

export async function fetchVideoClips(videoId: string): Promise<Clip[]> {
  const [rows] = await bigQuery.query({
    query: `SELECT clip_id, video_id, title, category, duration_ms, viral_score,
                   viral_reason, transcript, speaker, gcs_url, vizard_editor_url, persona
            FROM \`${CLIPS_TABLE}\`
            WHERE video_id = @videoId
            ORDER BY category ASC`,
    params: { videoId },
  });

  return (rows || []).map((r: any) => ({
    clipId: r.clip_id,
    videoId: r.video_id,
    title: r.title,
    category: r.category,
    durationMs: r.duration_ms,
    viralScore: r.viral_score ?? null,
    viralReason: r.viral_reason ?? null,
    transcript: r.transcript ?? null,
    speaker: r.speaker ?? null,
    gcsUrl: r.gcs_url,
    vizardEditorUrl: r.vizard_editor_url ?? null,
    persona: r.persona ?? null,
  }));
}

export async function fetchAutoSnippets(videoId: string): Promise<AutoSnippet[]> {
  const [rows] = await bigQuery.query({
    query: `SELECT snippet_id, original_video_id, title, description, category,
                   duration_ms, transcript, gcs_url, provider, speaker, created_at
            FROM \`${SNIPPETS_AUTO_TABLE}\`
            WHERE original_video_id = @videoId
            ORDER BY category ASC`,
    params: { videoId },
  });

  return (rows || []).map((r: any) => ({
    snippetId: r.snippet_id,
    originalVideoId: r.original_video_id,
    title: r.title,
    description: r.description ?? null,
    category: r.category,
    durationMs: r.duration_ms,
    transcript: r.transcript ?? null,
    gcsUrl: r.gcs_url,
    provider: r.provider ?? null,
    speaker: r.speaker ?? null,
    createdAt: r.created_at?.value ?? (r.created_at ? String(r.created_at) : null),
  }));
}

/* ── Transcribe log (admin Pipeline Log data source) ── */

const TRANSCRIBE_LOG_TABLE = "youtubetranscripts-429803.reptranscripts.transcribe_log";

export interface TranscribeLogRow {
  video_id: string;
  requested_at: string;
  speaker: string | null;
  video_title: string | null;
  channel_name: string | null;
  channel_id: string | null;
  published_date: string | null;
  duration_seconds: number | null;
  youtube_link: string;
}

export async function fetchTranscribeLog(opts: {
  page?: number;
  pageSize?: number;
  videoId?: string | null;
}): Promise<{ rows: TranscribeLogRow[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 20));
  const offset = (page - 1) * pageSize;
  const videoId = opts.videoId ?? null;
  const where = videoId ? "WHERE video_id = @videoId" : "";

  const [countRows] = await bigQuery.query({
    query: `SELECT COUNT(*) AS total FROM \`${TRANSCRIBE_LOG_TABLE}\` ${where}`,
    params: videoId ? { videoId } : {},
  });
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await bigQuery.query({
    query: `
      SELECT
        video_id,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ', requested_at, 'UTC') AS requested_at,
        speaker,
        video_title,
        channel_name,
        channel_id,
        CAST(published_date AS STRING) AS published_date,
        duration_seconds,
        youtube_link
      FROM \`${TRANSCRIBE_LOG_TABLE}\`
      ${where}
      ORDER BY requested_at DESC
      LIMIT @pageSize OFFSET @offset
    `,
    params: videoId ? { videoId, pageSize, offset } : { pageSize, offset },
  });

  return {
    rows: rows.map((r: any) => ({
      video_id: String(r.video_id),
      requested_at: String(r.requested_at),
      speaker: r.speaker ?? null,
      video_title: r.video_title ?? null,
      channel_name: r.channel_name ?? null,
      channel_id: r.channel_id ?? null,
      published_date: r.published_date ?? null,
      duration_seconds: r.duration_seconds === null || r.duration_seconds === undefined ? null : Number(r.duration_seconds),
      youtube_link: String(r.youtube_link || `https://youtu.be/${r.video_id}`),
    })),
    total,
  };
}

/* ── Clip exports (admin /log Clips tab data source) ── */

const CLIP_EXPORTS_TABLE = "youtubetranscripts-429803.reptranscripts.clip_exports";

export interface ClipExportRow {
  job_id: string;
  video_id: string;
  video_url: string | null;
  start_sec: number;
  end_sec: number;
  clip_duration_sec: number;
  quality: string | null;
  status: string;              // "complete" | "failed" | "rejected"
  error: string | null;
  total_sec: number | null;
  rapidapi_sec: number | null;
  download_sec: number | null;
  trim_sec: number | null;
  file_size_bytes: number | null;
  video_duration_sec: number | null;
  video_resolution: string | null;
  created_at: string;
  // Joined from transcribe_log (nullable — not every source video was transcribed)
  video_title: string | null;
  channel_name: string | null;
  speaker: string | null;
}

export async function fetchClipExports(opts: {
  page?: number;
  pageSize?: number;
  videoId?: string | null;
}): Promise<{ rows: ClipExportRow[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 20));
  const offset = (page - 1) * pageSize;
  const videoId = opts.videoId ?? null;
  const where = videoId ? "WHERE c.video_id = @videoId" : "";

  const [countRows] = await bigQuery.query({
    query: `SELECT COUNT(*) AS total FROM \`${CLIP_EXPORTS_TABLE}\` c ${where}`,
    params: videoId ? { videoId } : {},
  });
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await bigQuery.query({
    query: `
      SELECT
        c.job_id, c.video_id, c.video_url,
        c.start_sec, c.end_sec, c.clip_duration_sec,
        c.quality, c.status, c.error,
        c.total_sec, c.rapidapi_sec, c.download_sec, c.trim_sec,
        c.file_size_bytes, c.video_duration_sec, c.video_resolution,
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ', c.created_at, 'UTC') AS created_at,
        t.video_title, t.channel_name, t.speaker
      FROM \`${CLIP_EXPORTS_TABLE}\` c
      LEFT JOIN \`${TRANSCRIBE_LOG_TABLE}\` t
        ON t.video_id = c.video_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT @pageSize OFFSET @offset
    `,
    params: videoId ? { videoId, pageSize, offset } : { pageSize, offset },
  });

  const numOrNull = (v: any) => (v === null || v === undefined ? null : Number(v));

  return {
    rows: rows.map((r: any) => ({
      job_id: String(r.job_id || ""),
      video_id: String(r.video_id || ""),
      video_url: r.video_url ?? null,
      start_sec: Number(r.start_sec ?? 0),
      end_sec: Number(r.end_sec ?? 0),
      clip_duration_sec: Number(r.clip_duration_sec ?? 0),
      quality: r.quality ?? null,
      status: String(r.status || ""),
      error: r.error ?? null,
      total_sec: numOrNull(r.total_sec),
      rapidapi_sec: numOrNull(r.rapidapi_sec),
      download_sec: numOrNull(r.download_sec),
      trim_sec: numOrNull(r.trim_sec),
      file_size_bytes: numOrNull(r.file_size_bytes),
      video_duration_sec: numOrNull(r.video_duration_sec),
      video_resolution: r.video_resolution ?? null,
      created_at: String(r.created_at || ""),
      video_title: r.video_title ?? null,
      channel_name: r.channel_name ?? null,
      speaker: r.speaker ?? null,
    })),
    total,
  };
}
