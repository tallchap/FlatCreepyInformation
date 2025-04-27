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
      whereConditions.push(
        'LOWER(Search_Doc_1) LIKE CONCAT("%", LOWER(@searchQuery), "%")'
      );
      queryParams.searchQuery = params.searchQuery;
    }

    if (params.speakerQuery) {
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
      whereConditions.push(
        "EXTRACT(YEAR FROM CAST(Upload_Date AS TIMESTAMP)) = @yearFilter"
      );
      queryParams.yearFilter = parseInt(params.yearFilter);
    }

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    let orderByClause;
    switch (params.sortOrder) {
      case "recent":
        orderByClause = "ORDER BY Upload_Date DESC";
        break;
      case "oldest":
        orderByClause = "ORDER BY Upload_Date ASC";
        break;
      case "relevance":
      default:
        // For relevance, we'd typically use a more complex scoring system
        // but for simplicity, we'll just order by upload date as a fallback
        orderByClause = "ORDER BY Upload_Date DESC";
    }
    const limitClause = `LIMIT ${parseInt(params.resultLimit) || 10}`;
    const query = `
      SELECT 
        ID,
        Video_Title,
        Channel_Name,
        Upload_Date,
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
        const searchTerm = params.searchQuery.toLowerCase();

        // Find ALL instances of the search term
        const contextWindowSize = 110; // Expanded by 10 characters on each side (was 100)
        const maxSnippets = 5; // Limit to prevent excessive snippets

        let lastIndex = 0;
        let snippetCount = 0;

        // Continue searching for instances until we find them all or hit our max
        while (lastIndex !== -1 && snippetCount < maxSnippets) {
          const startIndex = transcript.indexOf(searchTerm, lastIndex);

          if (startIndex === -1) break; // No more instances found

          // Get a context window around the match
          const snippetStart = Math.max(0, startIndex - contextWindowSize);
          const snippetEnd = Math.min(
            transcript.length,
            startIndex + searchTerm.length + contextWindowSize
          );

          let snippet = transcript.substring(snippetStart, snippetEnd);

          // Mark the search term in the snippet
          const termStart = startIndex - snippetStart;
          const termEnd = termStart + searchTerm.length;
          snippet =
            snippet.substring(0, termStart) +
            `<mark>${snippet.substring(termStart, termEnd)}</mark>` +
            snippet.substring(termEnd);

          snippets.push(snippet);

          // Move past this occurrence to find the next one
          lastIndex = startIndex + searchTerm.length;
          snippetCount++;
        }
      }

      return {
        ...row,
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
