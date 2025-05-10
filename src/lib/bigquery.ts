// src/lib/bigquery.ts
// ─────────────────────────────────────────────────────────────
//  BigQuery helpers for Snippysaurus
//  • fetchVideoMeta(id)      → high-level video metadata
//  • fetchTranscript(id)     → [{ start: seconds, text: string }, …]
// ─────────────────────────────────────────────────────────────
import { BigQuery } from "@google-cloud/bigquery";

/* 1 ▸ initialise BigQuery client (reuse between hot-reloads) */
const credentials = JSON.parse(
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}",
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
        Extracted_Speakers  AS speakers
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

  /* Parse each timestamped line */
  return raw
    .trim()
    .split(/\n+/)
    .map((ln) => {
      // Matches [mm:ss] …   or   [hh:mm:ss] …
      const match = ln.match(/^\[(\d{2}):(\d{2})(?::(\d{2}))?]\s*(.*)$/);
      if (!match) return null;

      const [, a, b, c, text] = match; // a=mm or hh, b=ss or mm, c=ss?
      const seconds = c
        ? +a * 3600 + +b * 60 + +c // [hh:mm:ss]
        : +a * 60 + +b; // [mm:ss]

      return { start: seconds, text };
    })
    .filter(Boolean) as { start: number; text: string }[];
}
