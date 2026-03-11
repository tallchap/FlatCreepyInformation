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
          video_title AS title,
          channel_name AS channel,
          published_date AS published,
          video_length AS video_length,
          youtube_link AS youtube_url,
          speaker_source AS speakers
        FROM ${VIDEOS_TABLE}
        WHERE video_id = @id
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
        SELECT start_sec, text
        FROM ${SEGMENTS_TABLE}
        WHERE video_id = @id
        ORDER BY COALESCE(start_sec, 1e12), segment_index
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
