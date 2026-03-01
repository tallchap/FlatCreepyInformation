// src/lib/bigquery.ts
// ─────────────────────────────────────────────────────────────
//  BigQuery helpers for Snippysaurus
//  • fetchVideoMeta(id)      → high-level video metadata
//  • fetchTranscript(id)     → [{ start: seconds, text: string }, …]
// ─────────────────────────────────────────────────────────────
import { BigQuery } from "@google-cloud/bigquery";

/* 1 ▸ initialise BigQuery client (reuse between hot-reloads) */
function parseServiceAccount(raw: string | undefined) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Handles env payloads where private_key contains literal newlines.
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

/*─────────────────────────────────────────────────────────────*/
/*  VIDEO-LEVEL METADATA                                       */
/*─────────────────────────────────────────────────────────────*/
export async function fetchVideoMeta(id: string) {
  const [rows] = await bigQuery.query({
    query: `
      SELECT
        Video_Title         AS title,
        Channel_Name        AS channel,
        Published_Date      AS published,          -- DATE
        Video_Length        AS video_length,       -- e.g. "5:52"
        CONCAT('https://youtu.be/', ID) AS youtube_url,
        COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS speakers
      FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
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

/*─────────────────────────────────────────────────────────────*/
/*  TRANSCRIPT PARSER                                          */
/*─────────────────────────────────────────────────────────────*/
/**
 * Convert Search_Doc_1 lines like “[00:42] some text” (or “[01:02:05] …”)
 * into an array sorted by `start` seconds:
 *   [{ start: 42, text: "some text" }, …]
 */
/*─────────────────────────────────────────────────────────────*/
/*  BROWSE HELPERS                                              */
/*─────────────────────────────────────────────────────────────*/

const TABLE = "`youtubetranscripts-429803.reptranscripts.youtube_transcripts`";
const SPEAKERS_EXPR = `COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude)`;

/**
 * Return every distinct speaker (alphabetical) with their video count.
 * Speakers are comma-separated in the source column, so we UNNEST after
 * splitting and trim each name.
 */
export async function fetchAllSpeakers(
  page = 1,
  pageSize = 100,
): Promise<{ speakers: { name: string; videoCount: number }[]; total: number }> {
  const offset = (page - 1) * pageSize;

  // Count query
  const [countRows] = await bigQuery.query({
    query: `
      SELECT COUNT(DISTINCT TRIM(speaker)) AS total
      FROM ${TABLE},
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS speaker
      WHERE TRIM(speaker) != ''
    `,
  });
  const total = Number(countRows[0]?.total ?? 0);

  // Data query
  const [rows] = await bigQuery.query({
    query: `
      SELECT
        TRIM(speaker) AS name,
        COUNT(DISTINCT ID) AS videoCount
      FROM ${TABLE},
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS speaker
      WHERE TRIM(speaker) != ''
      GROUP BY name
      ORDER BY name ASC
      LIMIT @pageSize OFFSET @offset
    `,
    params: { pageSize, offset },
  });

  return {
    speakers: rows.map((r: { name: string; videoCount: number }) => ({
      name: r.name,
      videoCount: Number(r.videoCount),
    })),
    total,
  };
}

/**
 * For a given speaker, return every year they appear in + video count per year.
 */
export async function fetchSpeakerYears(
  speaker: string,
): Promise<{ year: number; videoCount: number }[]> {
  const [rows] = await bigQuery.query({
    query: `
      SELECT
        EXTRACT(YEAR FROM Published_Date) AS year,
        COUNT(DISTINCT ID) AS videoCount
      FROM ${TABLE},
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS s
      WHERE TRIM(s) = @speaker
      GROUP BY year
      ORDER BY year DESC
    `,
    params: { speaker },
  });

  return rows.map((r: { year: number; videoCount: number }) => ({
    year: Number(r.year),
    videoCount: Number(r.videoCount),
  }));
}

/**
 * For a given speaker + year, return months with video counts.
 */
export async function fetchSpeakerYearMonths(
  speaker: string,
  year: number,
): Promise<{ month: number; videoCount: number }[]> {
  const [rows] = await bigQuery.query({
    query: `
      SELECT
        EXTRACT(MONTH FROM Published_Date) AS month,
        COUNT(DISTINCT ID) AS videoCount
      FROM ${TABLE},
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS s
      WHERE TRIM(s) = @speaker
        AND EXTRACT(YEAR FROM Published_Date) = @year
      GROUP BY month
      ORDER BY month ASC
    `,
    params: { speaker, year },
  });

  return rows.map((r: { month: number; videoCount: number }) => ({
    month: Number(r.month),
    videoCount: Number(r.videoCount),
  }));
}

/**
 * For a given speaker + year + month, return paginated video list.
 */
export async function fetchSpeakerMonthVideos(
  speaker: string,
  year: number,
  month: number,
  page = 1,
  pageSize = 100,
): Promise<{
  videos: {
    id: string;
    title: string;
    channel: string;
    published: string;
    speakers: string;
    youtubeUrl: string;
    videoLength: string | null;
  }[];
  total: number;
}> {
  const offset = (page - 1) * pageSize;

  const [countRows] = await bigQuery.query({
    query: `
      SELECT COUNT(DISTINCT ID) AS total
      FROM ${TABLE},
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS s
      WHERE TRIM(s) = @speaker
        AND EXTRACT(YEAR FROM Published_Date) = @year
        AND EXTRACT(MONTH FROM Published_Date) = @month
    `,
    params: { speaker, year, month },
  });
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await bigQuery.query({
    query: `
      SELECT DISTINCT
        ID AS id,
        Video_Title AS title,
        Channel_Name AS channel,
        CAST(Published_Date AS STRING) AS published,
        ${SPEAKERS_EXPR} AS speakers,
        CONCAT('https://youtu.be/', ID) AS youtubeUrl,
        Video_Length AS videoLength
      FROM ${TABLE},
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS s
      WHERE TRIM(s) = @speaker
        AND EXTRACT(YEAR FROM Published_Date) = @year
        AND EXTRACT(MONTH FROM Published_Date) = @month
      ORDER BY published DESC
      LIMIT @pageSize OFFSET @offset
    `,
    params: { speaker, year, month, pageSize, offset },
  });

  return {
    videos: rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      title: String(r.title),
      channel: String(r.channel),
      published: String(r.published),
      speakers: String(r.speakers ?? ""),
      youtubeUrl: String(r.youtubeUrl),
      videoLength: r.videoLength ? String(r.videoLength) : null,
    })),
    total,
  };
}

/**
 * For a given speaker + year, return paginated video list (all months).
 */
export async function fetchSpeakerYearVideos(
  speaker: string,
  year: number,
  page = 1,
  pageSize = 100,
): Promise<{
  videos: {
    id: string;
    title: string;
    channel: string;
    published: string;
    speakers: string;
    youtubeUrl: string;
    videoLength: string | null;
  }[];
  total: number;
}> {
  const offset = (page - 1) * pageSize;

  const [countRows] = await bigQuery.query({
    query: `
      SELECT COUNT(DISTINCT ID) AS total
      FROM ${TABLE},
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS s
      WHERE TRIM(s) = @speaker
        AND EXTRACT(YEAR FROM Published_Date) = @year
    `,
    params: { speaker, year },
  });
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await bigQuery.query({
    query: `
      SELECT DISTINCT
        ID AS id,
        Video_Title AS title,
        Channel_Name AS channel,
        CAST(Published_Date AS STRING) AS published,
        ${SPEAKERS_EXPR} AS speakers,
        CONCAT('https://youtu.be/', ID) AS youtubeUrl,
        Video_Length AS videoLength
      FROM ${TABLE},
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS s
      WHERE TRIM(s) = @speaker
        AND EXTRACT(YEAR FROM Published_Date) = @year
      ORDER BY published DESC
      LIMIT @pageSize OFFSET @offset
    `,
    params: { speaker, year, pageSize, offset },
  });

  return {
    videos: rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      title: String(r.title),
      channel: String(r.channel),
      published: String(r.published),
      speakers: String(r.speakers ?? ""),
      youtubeUrl: String(r.youtubeUrl),
      videoLength: r.videoLength ? String(r.videoLength) : null,
    })),
    total,
  };
}

/*─────────────────────────────────────────────────────────────*/
/*  TRANSCRIPT PARSER                                          */
/*─────────────────────────────────────────────────────────────*/

export async function fetchTranscript(id: string) {
  /* Grab the raw Search_Doc_1 field */
  const [rows] = await bigQuery.query({
    query: `
      SELECT Search_Doc_1
      FROM   \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
      WHERE  ID = @id
      LIMIT 1
    `,
    params: { id },
  });

  if (!rows?.length || !rows[0].Search_Doc_1) return [];

  const raw: string = rows[0].Search_Doc_1 as string;

  /* 2 ▸ parse lines */
  const out: { start: number | null; text: string }[] = [];

  raw.trim().split(/\n+/).forEach((ln) => {
    // [hh:mm:ss]  or [mm:ss]
    let m = ln.match(/^\[(\d+):(\d{2})(?::(\d{2}))?]\s*(.*)$/);
    if (m) {
      const [, a, b, c, txt] = m;
      const sec = (c ? +a * 3600 + +b * 60 + +c : +a * 60 + +b);
      out.push({ start: sec, text: txt });
      return;
    }

    // seconds.fraction:  (e.g. 12.64: text)
    m = ln.match(/^(\d+(?:\.\d+)?):\s*(.*)$/);
    if (m) {
      out.push({ start: parseFloat(m[1]), text: m[2] });
      return;
    }

    // plain line with NO timing – keep it, but mark start=null
    if (ln.trim()) out.push({ start: null, text: ln.trim() });
  });

  /* sort only lines that have real timestamps */
  out.sort((a, b) => {
    if (a.start === null) return 1;
    if (b.start === null) return -1;
    return a.start - b.start;
  });

  return out;
}
