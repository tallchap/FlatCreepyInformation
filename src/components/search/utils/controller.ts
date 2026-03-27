import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS, useNewTranscriptTables } from "@/lib/bigquery-schema";

const SEGMENT_LINE_EXPR = `CASE
  WHEN s.start_sec IS NOT NULL THEN CONCAT(
    '[',
    LPAD(CAST(FLOOR(s.start_sec / 60) AS STRING), 2, '0'),
    ':',
    LPAD(CAST(MOD(CAST(FLOOR(s.start_sec) AS INT64), 60) AS STRING), 2, '0'),
    '] ',
    s.text
  )
  ELSE s.text
END`;

// Text search uses segment_search_windows (3-segment sliding windows with SEARCH INDEX).
// Non-text browsing uses youtube_videos + youtube_transcript_segments directly.

export async function searchTranscripts(params: {
  searchQuery?: string;
  speakerQuery?: string;
  channelQuery?: string;
  sortOrder: string;
  resultLimit: string;
  yearFilter?: string;
}) {
  try {
    const queryParams: any = {};
    const videoConditions: string[] = [];
    const orderDir = params.sortOrder === "oldest" ? "ASC" : "DESC";
    const limit = parseInt(params.resultLimit) || 10;

    // Video-level filters (applied to youtube_videos)
    if (params.speakerQuery) {
      videoConditions.push(
        `LOWER(v.speaker_source) LIKE CONCAT("%", LOWER(@speakerQuery), "%")`,
      );
      queryParams.speakerQuery = params.speakerQuery;
    }

    if (params.channelQuery) {
      videoConditions.push(
        'LOWER(v.channel_name) LIKE CONCAT("%", LOWER(@channelQuery), "%")',
      );
      queryParams.channelQuery = params.channelQuery;
    }

    if (params.yearFilter && params.yearFilter !== "all") {
      if (params.yearFilter.startsWith("before:")) {
        const year = parseInt(params.yearFilter.split(":")[1]);
        videoConditions.push("EXTRACT(YEAR FROM v.published_date) < @yearFilter");
        queryParams.yearFilter = year;
      } else if (params.yearFilter.startsWith("after:")) {
        const year = parseInt(params.yearFilter.split(":")[1]);
        videoConditions.push("EXTRACT(YEAR FROM v.published_date) > @yearFilter");
        queryParams.yearFilter = year;
      } else {
        videoConditions.push("EXTRACT(YEAR FROM v.published_date) = @yearFilter");
        queryParams.yearFilter = parseInt(params.yearFilter);
      }
    }

    const videoWhereClause = videoConditions.length > 0
      ? `WHERE ${videoConditions.join(" AND ")}`
      : "";

    let query: string;

    if (params.searchQuery) {
      // Text search: use SEARCH() on windowed table (indexed, fast)
      const searchTerms = splitByOrOperator(params.searchQuery);
      const searchConditions = searchTerms.map((term, index) => {
        const paramName = `searchQuery${index}`;
        const trimmed = term.trim();
        // Multi-word phrases get double-quote-wrapped for exact phrase match
        const hasSpace = trimmed.includes(" ");
        queryParams[paramName] = hasSpace ? `"${trimmed}"` : trimmed;
        return `SEARCH(sw.window_text, @${paramName})`;
      });

      query = `
        WITH matching_videos AS (
          SELECT DISTINCT sw.video_id
          FROM ${TABLE_REFS.segmentSearchWindows} sw
          WHERE (${searchConditions.join(" OR ")})
        ),
        filtered_videos AS (
          SELECT v.video_id, v.video_title, v.channel_name, v.published_date,
                 v.speaker_source, v.youtube_link, v.video_length
          FROM ${TABLE_REFS.videos} v
          INNER JOIN matching_videos mv ON v.video_id = mv.video_id
          ${videoWhereClause}
          ORDER BY v.published_date ${orderDir}
          LIMIT ${limit}
        )
        SELECT
          fv.video_id AS ID,
          fv.video_title AS Video_Title,
          fv.channel_name AS Channel_Name,
          fv.published_date AS Published_Date,
          fv.speaker_source AS Speakers,
          fv.youtube_link AS Youtube_Link,
          fv.video_length AS Video_Length,
          '' AS Transcript_Doc_Link,
          STRING_AGG(
            ${SEGMENT_LINE_EXPR},
            '\n' ORDER BY COALESCE(s.start_sec, 1e12), s.segment_index
          ) AS Search_Doc_1
        FROM filtered_videos fv
        LEFT JOIN ${TABLE_REFS.transcriptSegments} s ON fv.video_id = s.video_id
        GROUP BY fv.video_id, fv.video_title, fv.channel_name, fv.published_date,
                 fv.speaker_source, fv.youtube_link, fv.video_length
        ORDER BY fv.published_date ${orderDir}
      `;
    } else {
      // No text search — query videos directly, aggregate segments for transcript
      query = `
        WITH filtered_videos AS (
          SELECT v.video_id, v.video_title, v.channel_name, v.published_date,
                 v.speaker_source, v.youtube_link, v.video_length
          FROM ${TABLE_REFS.videos} v
          ${videoWhereClause}
          ORDER BY v.published_date ${orderDir}
          LIMIT ${limit}
        )
        SELECT
          fv.video_id AS ID,
          fv.video_title AS Video_Title,
          fv.channel_name AS Channel_Name,
          fv.published_date AS Published_Date,
          fv.speaker_source AS Speakers,
          fv.youtube_link AS Youtube_Link,
          fv.video_length AS Video_Length,
          '' AS Transcript_Doc_Link,
          STRING_AGG(
            ${SEGMENT_LINE_EXPR},
            '\n' ORDER BY COALESCE(s.start_sec, 1e12), s.segment_index
          ) AS Search_Doc_1
        FROM filtered_videos fv
        LEFT JOIN ${TABLE_REFS.transcriptSegments} s ON fv.video_id = s.video_id
        GROUP BY fv.video_id, fv.video_title, fv.channel_name, fv.published_date,
                 fv.speaker_source, fv.youtube_link, fv.video_length
        ORDER BY fv.published_date ${orderDir}
      `;
    }

    const [rows] = await bigQuery.query({ query, params: queryParams });

    const results = rows.map((row: any) => {
      let snippets: { text: string; seconds: number | null }[] = [];
      if (params.searchQuery && row.Search_Doc_1) {
        const original: string = row.Search_Doc_1;
        const transcript = original.toLowerCase();
        const tsIndex = buildTimestampIndex(original);
        const searchTerms = splitByOrOperator(params.searchQuery);

        for (const rawTerm of searchTerms) {
          const termToSearch = rawTerm.trim().toLowerCase();
          const contextWindowSize = 110;
          const maxSnippets = 5;

          let searchPos = 0;
          let snippetCount = 0;
          while (snippetCount < maxSnippets) {
            const matchIndex = transcript.indexOf(termToSearch, searchPos);
            if (matchIndex === -1) break;

            const snippetStart = Math.max(0, matchIndex - contextWindowSize);
            const snippetEnd = Math.min(original.length, matchIndex + termToSearch.length + contextWindowSize);
            let snippet = original.substring(snippetStart, snippetEnd);
            const termStart = matchIndex - snippetStart;
            const termEnd = termStart + termToSearch.length;

            snippet = snippet.substring(0, termStart) + `<mark>${snippet.substring(termStart, termEnd)}</mark>` + snippet.substring(termEnd);
            snippet = snippet.replace(/\[\d+:\d{2}(?::\d{2})?]:?\s*/g, "");
            snippet = snippet.replace(/(?:^|\s)\d+(?:\.\d+)?:\s*/g, " ");
            snippet = snippet.replace(/^[^a-zA-Z<]+/, "");

            const seconds = findNearestTimestamp(tsIndex, matchIndex);
            snippets.push({ text: snippet, seconds });
            snippetCount++;
            searchPos = matchIndex + termToSearch.length;
          }
        }
      }

      return {
        ...row,
        Published_Date:
          typeof row.Published_Date?.value === "string"
            ? row.Published_Date.value
            : row.Published_Date?.value?.toString() || row.Published_Date?.toString() || null,
        SearchTerm: params.searchQuery || "",
        MatchSnippets: snippets.length > 0 ? snippets : undefined,
      };
    });

    return { results, total: results.length, uniqueVideos: results.length };
  } catch (error) {
    console.error("BigQuery search error:", error);
    return {
      results: [],
      total: 0,
      uniqueVideos: 0,
      error: error instanceof Error ? error.message : "Search failed",
    };
  }
}

function splitByOrOperator(query: string): string[] {
  const result: string[] = [];
  let currentTerm = "";
  let inQuotes = false;
  const tokens = query.split(/\s+/);

  for (const token of tokens) {
    if (token.startsWith('"') && token.endsWith('"') && token.length > 1) {
      if (currentTerm) result.push(currentTerm.trim());
      result.push(token.slice(1, -1));
      currentTerm = "";
      continue;
    }
    if (token.startsWith('"')) {
      inQuotes = true;
      currentTerm = token.slice(1) + " ";
      continue;
    }
    if (token.endsWith('"') && inQuotes) {
      inQuotes = false;
      currentTerm += token.slice(0, -1);
      result.push(currentTerm.trim());
      currentTerm = "";
      continue;
    }
    if (token.toUpperCase() === "OR" && !inQuotes && currentTerm) {
      result.push(currentTerm.trim());
      currentTerm = "";
      continue;
    }
    if (inQuotes || token.toUpperCase() !== "OR") currentTerm += token + " ";
  }

  if (currentTerm) result.push(currentTerm.trim());
  return result.filter((term) => term.length > 0);
}

function buildTimestampIndex(transcript: string): { pos: number; sec: number }[] {
  const index: { pos: number; sec: number }[] = [];
  const reBracket = /\[(\d+):(\d{2})(?::(\d{2}))?\]/g;
  const reDecimal = /(?:^|\n)(\d+(?:\.\d+)?):/gm;

  let m: RegExpExecArray | null;
  while ((m = reBracket.exec(transcript)) !== null) {
    const [, a, b, c] = m;
    const sec = c ? +a * 3600 + +b * 60 + +c : +a * 60 + +b;
    index.push({ pos: m.index, sec });
  }
  while ((m = reDecimal.exec(transcript)) !== null) {
    index.push({ pos: m.index, sec: parseFloat(m[1]) });
  }
  index.sort((a, b) => a.pos - b.pos);
  return index;
}

function findNearestTimestamp(index: { pos: number; sec: number }[], matchPos: number): number | null {
  if (index.length === 0) return null;

  let lo = 0;
  let hi = index.length - 1;
  let bestBefore = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (index[mid].pos <= matchPos) {
      bestBefore = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestBefore >= 0) return index[bestBefore].sec;
  return index[0]?.sec ?? 0;
}

export async function getTranscriptByVideoId(videoId: string): Promise<string> {
  try {
    const query = useNewTranscriptTables()
      ? `
        SELECT STRING_AGG(${SEGMENT_LINE_EXPR}, '\n' ORDER BY COALESCE(s.start_sec, 1e12), s.segment_index) AS Search_Doc_1
        FROM ${TABLE_REFS.transcriptSegments} s
        WHERE s.video_id = @videoId
      `
      : `
        SELECT Search_Doc_1
        FROM ${TABLE_REFS.legacyTranscripts}
        WHERE ID = @videoId
        LIMIT 1
      `;

    const [rows] = await bigQuery.query({ query, params: { videoId } });
    if (rows && rows.length > 0 && rows[0].Search_Doc_1) return rows[0].Search_Doc_1;
    return "";
  } catch (error: any) {
    console.error("BigQuery error:", error);
    return "";
  }
}
