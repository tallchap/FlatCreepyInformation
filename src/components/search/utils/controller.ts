import { bigQuery } from "@/lib/bigquery";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      // Process search query for wildcards and OR operators
      const searchTerms = processSearchQuery(params.searchQuery);
      const searchConditions = searchTerms.map((term, index) => {
        const paramName = `searchQuery${index}`;

        if (term.hasWildcard) {
          // \b at start only — prefix match at word boundary
          queryParams[paramName] = `\\b${escapeRegex(term.value.toLowerCase())}`;
          return `REGEXP_CONTAINS(LOWER(Search_Doc_1), @${paramName})`;
        } else {
          // \b on both sides — whole word match
          queryParams[paramName] = `\\b${escapeRegex(term.value.toLowerCase())}\\b`;
          return `REGEXP_CONTAINS(LOWER(Search_Doc_1), @${paramName})`;
        }
      });

      // Join conditions based on OR logic from the query
      if (searchConditions.length > 0) {
        whereConditions.push(`(${searchConditions.join(" OR ")})`);
      }
    }

    if (params.speakerQuery) {
      // Generate alternative spellings for fuzzy matching
      whereConditions.push(
        'LOWER(COALESCE(NULLIF(Speakers_GPT_Third, ""), Speakers_Claude)) LIKE CONCAT("%", LOWER(@speakerQuery), "%")'
      );
      queryParams.speakerQuery = params.speakerQuery;
    }

    if (params.channelQuery) {
      whereConditions.push(
        'LOWER(Channel_Name) LIKE CONCAT("%", LOWER(@channelQuery), "%")'
      );
      queryParams.channelQuery = params.channelQuery;
    }
    if (params.yearFilter && params.yearFilter !== "all") {
      whereConditions.push("EXTRACT(YEAR FROM Published_Date) = @yearFilter");
      queryParams.yearFilter = parseInt(params.yearFilter);
    }

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    let orderByClause;
    switch (params.sortOrder) {
      case "recent":
        orderByClause = "ORDER BY Published_Date DESC";
        break;
      case "oldest":
        orderByClause = "ORDER BY Published_Date ASC";
        break;
      default:
        // Default sorting by most recent if no valid sort order specified
        orderByClause = "ORDER BY Published_Date DESC";
    }
    const limitClause = `LIMIT ${parseInt(params.resultLimit) || 10}`;
    const query = `
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
      FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
      ${whereClause}
      ${orderByClause}
      ${limitClause}
    `;
    const [rows] = await bigQuery.query({
      query: query,
      params: queryParams,
    });
    const results = rows.map((row: any) => {
      // Create snippets if search query exists
      let snippets: { text: string; seconds: number | null }[] = [];
      if (params.searchQuery && row.Search_Doc_1) {
        const original: string = row.Search_Doc_1;
        const transcript = original.toLowerCase();
        const tsIndex = buildTimestampIndex(original);
        const processedTerms = processSearchQuery(params.searchQuery);

        // Find snippets for all search terms
        for (const term of processedTerms) {
          const searchTerm = term.value.toLowerCase();
          const termToSearch = term.hasWildcard
            ? searchTerm // Use base term without * for searching
            : searchTerm;

          // Find ALL whole-word instances of the search term
          const contextWindowSize = 110;
          const maxSnippets = 5;

          const escapedTerm = escapeRegex(termToSearch);
          const pattern = term.hasWildcard
            ? new RegExp(`\\b${escapedTerm}`, 'gi')
            : new RegExp(`\\b${escapedTerm}\\b`, 'gi');

          let match: RegExpExecArray | null;
          let snippetCount = 0;

          while ((match = pattern.exec(transcript)) !== null && snippetCount < maxSnippets) {
            const startIndex = match.index;

            // Get context window around the match
            const snippetStart = Math.max(0, startIndex - contextWindowSize);
            const snippetEnd = Math.min(
              original.length,
              startIndex + termToSearch.length + contextWindowSize
            );

            // Extract display text from original (preserves casing)
            let snippet = original.substring(snippetStart, snippetEnd);

            // Mark the search term in the snippet, handling wildcards
            const termStart = startIndex - snippetStart;
            let termEnd;

            if (term.hasWildcard) {
              // For wildcard terms, highlight until the next space or punctuation
              termEnd = findWordEndIndex(
                snippet,
                termStart + termToSearch.length
              );
            } else {
              termEnd = termStart + termToSearch.length;
            }

            snippet =
              snippet.substring(0, termStart) +
              `<mark>${snippet.substring(termStart, termEnd)}</mark>` +
              snippet.substring(termEnd);

            // Strip timestamps from display text
            snippet = snippet.replace(/\[\d+:\d{2}(?::\d{2})?\]:?\s*/g, '');
            snippet = snippet.replace(/(?:^|\s)\d+(?:\.\d+)?:\s*/g, ' ');
            snippet = snippet.replace(/^[\d:]*\]\s*/g, '');
            snippet = snippet.replace(/\s*\[\d+:?\d*$/g, '');

            // Strip leading partial word if we started mid-word
            if (snippetStart > 0 && /\w/.test(original[snippetStart - 1] || '')) {
              const firstSpace = snippet.indexOf(' ');
              const firstMark = snippet.indexOf('<mark>');
              if (firstSpace !== -1 && (firstMark === -1 || firstSpace < firstMark)) {
                snippet = snippet.substring(firstSpace + 1);
              }
            }
            // Strip trailing partial word if we ended mid-word
            if (snippetEnd < original.length && /\w/.test(original[snippetEnd] || '')) {
              const lastSpace = snippet.lastIndexOf(' ');
              const lastMarkEnd = snippet.lastIndexOf('</mark>');
              if (lastSpace > lastMarkEnd) {
                snippet = snippet.substring(0, lastSpace);
              }
            }
            // Clean any remaining leading non-letter junk
            snippet = snippet.replace(/^[^a-zA-Z<]+/, '');

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
            : row.Published_Date?.value?.toString() ||
              row.Published_Date?.toString() ||
              null,
        SearchTerm: params.searchQuery || "",
        MatchSnippets: snippets.length > 0 ? snippets : undefined,
      };
    });
    return {
      results,
      total: results.length,
      uniqueVideos: results.length,
    };
  } catch (error) {
    console.error("BigQuery search error:", error);
    return {
      results: [],
      total: 0,
      uniqueVideos: 0,
    };
  }
}

// Helper function to process the search query for wildcards and OR operators
function processSearchQuery(
  query: string
): Array<{ value: string; hasWildcard: boolean }> {
  // Split the query by the OR operator, respecting quotation marks
  const orTerms = splitByOrOperator(query);

  // Process each term for wildcards
  return orTerms.map((term) => {
    const trimmed = term.trim();
    const hasWildcard = trimmed.endsWith("*");

    // If has wildcard, use the term without the asterisk for the SQL query
    // BigQuery will handle the wildcard with LIKE operator
    const value = hasWildcard ? trimmed.slice(0, -1) : trimmed;

    return { value, hasWildcard };
  });
}

// Function to split a search query by "OR" operator, respecting quotes
function splitByOrOperator(query: string): string[] {
  const result: string[] = [];
  let currentTerm = "";
  let inQuotes = false;

  // Split by spaces to identify "OR" tokens
  const tokens = query.split(/\s+/);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Handle quotation marks
    if (token.startsWith('"') && token.endsWith('"') && token.length > 1) {
      // Complete quoted term
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

    // Handle OR operator (but not within quotes)
    if (token.toUpperCase() === "OR" && !inQuotes && currentTerm) {
      result.push(currentTerm.trim());
      currentTerm = "";
      continue;
    }

    // Add to current term
    if (inQuotes || token.toUpperCase() !== "OR") {
      currentTerm += token + " ";
    }
  }

  // Add the last term if exists
  if (currentTerm) {
    result.push(currentTerm.trim());
  }

  return result.filter((term) => term.length > 0);
}

// Helper function to find the end of a word when using wildcards
function findWordEndIndex(text: string, startIndex: number): number {
  // Look for the next space or non-alphanumeric character
  let endIndex = startIndex;
  while (
    endIndex < text.length &&
    (/[a-zA-Z0-9]/.test(text[endIndex]) || text[endIndex] === "_")
  ) {
    endIndex++;
  }
  return endIndex;
}

/**
 * Scan a transcript and return every timestamp's character position and seconds.
 * Handles `[MM:SS]`, `[HH:MM:SS]`, and `123.45:` formats.
 */
function buildTimestampIndex(
  transcript: string
): { pos: number; sec: number }[] {
  const index: { pos: number; sec: number }[] = [];
  // [HH:MM:SS] or [MM:SS]
  const reBracket = /\[(\d+):(\d{2})(?::(\d{2}))?\]/g;
  // decimal-seconds at start of line: 816.76:
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

/** Binary-search for the last timestamp at or before `matchPos`. */
function findNearestTimestamp(
  index: { pos: number; sec: number }[],
  matchPos: number
): number | null {
  if (index.length === 0) return null;
  let lo = 0;
  let hi = index.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (index[mid].pos <= matchPos) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? index[best].sec : null;
}

export async function getTranscriptByVideoId(videoId: string): Promise<string> {
  try {
    console.log(`Fetching transcript from BigQuery for video ID: ${videoId}`);

    // SQL query to fetch the full transcript from the new table
    const query = `
      SELECT Search_Doc_1
      FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
      WHERE ID = @videoId
      LIMIT 1
    `;

    // Query options with parameters to prevent SQL injection
    const options = {
      query: query,
      params: { videoId },
    };

    // Run the query
    const [rows] = await bigQuery.query(options);

    if (rows && rows.length > 0 && rows[0].Search_Doc_1) {
      console.log(
        `Found transcript in BigQuery, length: ${rows[0].Search_Doc_1.length} chars`
      );
      return rows[0].Search_Doc_1;
    } else {
      console.log("No transcript found in BigQuery");
      return "";
    }
  } catch (error: any) {
    console.error("BigQuery error:", error);
    return "";
  }
}
