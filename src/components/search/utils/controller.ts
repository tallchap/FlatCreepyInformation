import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS, useNewTranscriptTables } from "@/lib/bigquery-schema";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function buildBaseSelect() {
  if (useNewTranscriptTables()) {
    return `
      WITH transcripts AS (
        SELECT
          s.video_id,
          STRING_AGG(${SEGMENT_LINE_EXPR}, '\n' ORDER BY COALESCE(s.start_sec, 1e12), s.segment_index) AS Search_Doc_1
        FROM ${TABLE_REFS.transcriptSegments} s
        GROUP BY s.video_id
      )
      SELECT
        v.video_id AS ID,
        v.video_title AS Video_Title,
        v.channel_name AS Channel_Name,
        v.published_date AS Published_Date,
        v.speaker_source AS Speakers,
        v.youtube_link AS Youtube_Link,
        v.video_length AS Video_Length,
        NULL AS Transcript_Doc_Link,
        t.Search_Doc_1
      FROM ${TABLE_REFS.videos} v
      LEFT JOIN transcripts t ON t.video_id = v.video_id
    `;
  }

  return `
    SELECT
      ID,
      Video_Title,
      Channel_Name,
      Published_Date,
      COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude) AS Speakers,
      Youtube_Link,
      Video_Length,
      Transcript_Doc_Link,
      Search_Doc_1
    FROM ${TABLE_REFS.legacyTranscripts}
  `;
}

export async function searchTranscripts(params: {
  searchQuery?: string;
  speakerQuery?: string;
  channelQuery?: string;
  sortOrder: string;
  resultLimit: string;
  yearFilter?: string;
}) {
  try {
    const whereConditions = [];
    const queryParams: any = {};

    if (params.searchQuery) {
      const searchTerms = processSearchQuery(params.searchQuery);
      const searchConditions = searchTerms.map((term, index) => {
        const paramName = `searchQuery${index}`;
        queryParams[paramName] = term.hasWildcard
          ? `\\b${escapeRegex(term.value.toLowerCase())}`
          : `\\b${escapeRegex(term.value.toLowerCase())}\\b`;
        return `REGEXP_CONTAINS(LOWER(Search_Doc_1), @${paramName})`;
      });
      if (searchConditions.length > 0) {
        whereConditions.push(`(${searchConditions.join(" OR ")})`);
      }
    }

    if (params.speakerQuery) {
      whereConditions.push(
        'LOWER(Speakers) LIKE CONCAT("%", LOWER(@speakerQuery), "%")',
      );
      queryParams.speakerQuery = params.speakerQuery;
    }

    if (params.channelQuery) {
      whereConditions.push(
        'LOWER(Channel_Name) LIKE CONCAT("%", LOWER(@channelQuery), "%")',
      );
      queryParams.channelQuery = params.channelQuery;
    }

    if (params.yearFilter && params.yearFilter !== "all") {
      whereConditions.push("EXTRACT(YEAR FROM Published_Date) = @yearFilter");
      queryParams.yearFilter = parseInt(params.yearFilter);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";
    const orderByClause = params.sortOrder === "oldest" ? "ORDER BY Published_Date ASC" : "ORDER BY Published_Date DESC";
    const limitClause = `LIMIT ${parseInt(params.resultLimit) || 10}`;

    const query = `${buildBaseSelect()} ${whereClause} ${orderByClause} ${limitClause}`;
    const [rows] = await bigQuery.query({ query, params: queryParams });

    const results = rows.map((row: any) => {
      let snippets: { text: string; seconds: number | null }[] = [];
      if (params.searchQuery && row.Search_Doc_1) {
        const original: string = row.Search_Doc_1;
        const transcript = original.toLowerCase();
        const tsIndex = buildTimestampIndex(original);
        const processedTerms = processSearchQuery(params.searchQuery);

        for (const term of processedTerms) {
          const termToSearch = term.value.toLowerCase();
          const contextWindowSize = 110;
          const maxSnippets = 5;
          const escapedTerm = escapeRegex(termToSearch);
          const pattern = term.hasWildcard
            ? new RegExp(`\\b${escapedTerm}`, "gi")
            : new RegExp(`\\b${escapedTerm}\\b`, "gi");

          let match: RegExpExecArray | null;
          let snippetCount = 0;
          while ((match = pattern.exec(transcript)) !== null && snippetCount < maxSnippets) {
            const startIndex = match.index;
            const snippetStart = Math.max(0, startIndex - contextWindowSize);
            const snippetEnd = Math.min(original.length, startIndex + termToSearch.length + contextWindowSize);
            let snippet = original.substring(snippetStart, snippetEnd);
            const termStart = startIndex - snippetStart;
            const termEnd = term.hasWildcard
              ? findWordEndIndex(snippet, termStart + termToSearch.length)
              : termStart + termToSearch.length;

            snippet = snippet.substring(0, termStart) + `<mark>${snippet.substring(termStart, termEnd)}</mark>` + snippet.substring(termEnd);
            snippet = snippet.replace(/\[\d+:\d{2}(?::\d{2})?]:?\s*/g, "");
            snippet = snippet.replace(/(?:^|\s)\d+(?:\.\d+)?:\s*/g, " ");
            snippet = snippet.replace(/^[^a-zA-Z<]+/, "");

            const seconds = findNearestTimestamp(tsIndex, startIndex);
            snippets.push({ text: snippet, seconds });
            snippetCount++;
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
    return { results: [], total: 0, uniqueVideos: 0 };
  }
}

function processSearchQuery(query: string): Array<{ value: string; hasWildcard: boolean }> {
  const orTerms = splitByOrOperator(query);
  return orTerms.map((term) => {
    const trimmed = term.trim();
    const hasWildcard = trimmed.endsWith("*");
    return { value: hasWildcard ? trimmed.slice(0, -1) : trimmed, hasWildcard };
  });
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

function findWordEndIndex(text: string, startIndex: number): number {
  let endIndex = startIndex;
  while (endIndex < text.length && (/[a-zA-Z0-9]/.test(text[endIndex]) || text[endIndex] === "_")) endIndex++;
  return endIndex;
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

  // Primary: nearest timestamp at or before the match.
  if (bestBefore >= 0) return index[bestBefore].sec;

  // Fallback: if match appears before first parsed timestamp, use first timestamp after.
  // Final guard: 0 keeps the snippet playable/openable even when parsing is sparse.
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
