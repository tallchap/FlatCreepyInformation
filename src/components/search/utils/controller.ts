import { bigQuery } from "@/lib/bigquery";

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
          // For wildcard terms, append % to the parameter value for SQL LIKE
          queryParams[paramName] = `${term.value}%`;
          return `LOWER(Search_Doc_1) LIKE CONCAT("%", LOWER(@${paramName}), "")`;
        } else {
          queryParams[paramName] = term.value;
          return `LOWER(Search_Doc_1) LIKE CONCAT("%", LOWER(@${paramName}), "%")`;
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
        'LOWER(Extracted_Speakers) LIKE CONCAT("%", LOWER(@speakerQuery), "%")'
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
        Extracted_Speakers AS Speakers,
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
    const results = rows.map((row) => {
      // Create snippets if search query exists
      let snippets = [];
      if (params.searchQuery && row.Search_Doc_1) {
        const transcript = row.Search_Doc_1.toLowerCase();
        const processedTerms = processSearchQuery(params.searchQuery);

        // Find snippets for all search terms
        for (const term of processedTerms) {
          const searchTerm = term.value.toLowerCase();
          const termToSearch = term.hasWildcard
            ? searchTerm // Use base term without * for searching
            : searchTerm;

          // Find ALL instances of the search term
          const contextWindowSize = 110;
          const maxSnippets = 5;

          let lastIndex = 0;
          let snippetCount = 0;

          while (lastIndex !== -1 && snippetCount < maxSnippets) {
            let startIndex = transcript.indexOf(termToSearch, lastIndex);
            if (startIndex === -1) break; // No more instances found

            // Get context window around the match
            const snippetStart = Math.max(0, startIndex - contextWindowSize);
            const snippetEnd = Math.min(
              transcript.length,
              startIndex + termToSearch.length + contextWindowSize
            );

            let snippet = transcript.substring(snippetStart, snippetEnd);

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

            snippets.push(snippet);

            // Move past this occurrence to find the next one
            lastIndex = startIndex + termToSearch.length;
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
