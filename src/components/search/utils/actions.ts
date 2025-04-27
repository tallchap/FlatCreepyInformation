"use server";

import { z } from "zod";
import axios from "axios";
import { getTranscriptByVideoId, searchTranscripts } from "./controller";

const searchTranscriptSchema = z.object({
  searchQuery: z.string().min(1),
  speakerQuery: z.string().optional(),
  channelQuery: z.string().optional(),
  sortOrder: z.enum(["recent", "oldest"]),
  resultLimit: z.enum(["10", "100"]),
  yearFilter: z.string(),
});

export async function searchTranscript(prevState: any, formData: FormData) {
  try {
    const rawData = Object.fromEntries(formData);
    const validatedFields = searchTranscriptSchema.safeParse(rawData);
    if (!validatedFields.success) {
      return { error: "Invalid data" };
    }
    const { searchQuery, speakerQuery, sortOrder, resultLimit, yearFilter } =
      validatedFields.data;

    let searchResults = null;
    let searchSource = "Not found";

    try {
      searchResults = await searchTranscripts(validatedFields.data);
      if (
        searchResults &&
        searchResults.results &&
        searchResults.results.length > 0
      ) {
        console.log(
          `BigQuery search returned ${searchResults.results.length} results`
        );
        searchSource = "BigQuery";
      } else {
        console.log("No results found in BigQuery search");
      }
    } catch (error) {
      console.error("BigQuery search error:", error);
    }
    if (
      !searchResults ||
      !searchResults.results ||
      searchResults.results.length === 0
    ) {
      try {
        const response = await axios.get(
          "https://video-search-api-963611949144.us-central1.run.app/",
          {
            params: {
              ...(searchQuery ? { searchQuery } : {}),
              ...(speakerQuery ? { speakerQuery } : {}),
              ...(yearFilter && yearFilter !== "all" ? { yearFilter } : {}),
              sortOrder,
              resultLimit,
            },
          }
        );
        if (response.status === 200) {
          searchResults = await response.data;
          searchSource = "External API";
          console.log(
            `API search returned ${searchResults.results?.length || 0} results`
          );
        } else {
          console.error(`Search API responded with status: ${response.status}`);
          throw new Error(
            `Search API responded with status: ${response.status}`
          );
        }
      } catch (error) {
        console.error(error);
        throw error;
      }
    }
    return {
      ...searchResults,
      source: searchSource,
      formData: formData,
    };
  } catch (error) {
    console.error(error);
    return {
      error:
        error instanceof Error ? error.message : "An unknown error occurred",
    };
  }
}

export async function getTranscript(videoId: string) {
  let transcriptText = await getTranscriptByVideoId(videoId);
  let transcriptSource = transcriptText ? "BigQuery" : "Not found";
  if (!transcriptText) {
    try {
      const response = await axios.get(
        "https://video-search-api-963611949144.us-central1.run.app/",
        {
          params: {
            videoId,
            resultLimit: "1",
          },
        }
      );
      const data = await response.data;
      if (data.results && data.results.length > 0) {
        // Use the first result that matches our video ID
        const matchingResult = data.results.find(
          (result: any) => result.ID === videoId
        );

        if (matchingResult && matchingResult.Search_Doc_1) {
          transcriptText = matchingResult.Search_Doc_1;
          transcriptSource = "API - Search_Doc_1";
          console.log(
            `Found full transcript in search API, length: ${transcriptText.length} chars`
          );
        } else if (
          matchingResult &&
          matchingResult.MatchSnippets &&
          matchingResult.MatchSnippets.length > 0
        ) {
          // Join all snippets, removing HTML markup
          transcriptText = matchingResult.MatchSnippets.map((snippet: string) =>
            snippet.replace(/<\/?[^>]+(>|$)/g, "")
          ).join("\n\n");
          transcriptSource = "API - MatchSnippets combined";
          console.log(
            `Using MatchSnippets from search results, combined length: ${transcriptText.length} chars`
          );
        }
      }
      if (!transcriptText) {
        const transcriptResponse = await axios.get(
          "https://video-search-api-963611949144.us-central1.run.app/transcript",
          {
            params: {
              videoId,
            },
          }
        );

        const transcriptData = await transcriptResponse.data;
        if (transcriptData.results && transcriptData.results.length > 0) {
          const result = transcriptData.results[0];

          if (result.Search_Doc_1) {
            transcriptText = result.Search_Doc_1;
            transcriptSource = "API - Search_Doc_1";
            console.log(
              `Found full transcript in transcript API, length: ${transcriptText.length} chars`
            );
          } else if (result.MatchSnippet) {
            transcriptText = result.MatchSnippet;
            transcriptSource = "API - MatchSnippet";
            console.log(
              `Found MatchSnippet in transcript API, length: ${transcriptText.length} chars`
            );
          }
        }
      }
    } catch (error) {
      console.error(error);
    }
  }
  return {
    transcript: transcriptText,
    videoId: videoId,
    transcriptFound: transcriptText.length > 0,
    dataFound: transcriptText.length > 0,
    source: transcriptSource,
  };
}

export async function exportTranscripts(prevState: any, formData: FormData) {
  const rawData = Object.fromEntries(formData);
  const validatedFields = searchTranscriptSchema.safeParse(rawData);
  if (!validatedFields.success) {
    return { error: "Invalid data" };
  }

  const searchResults = await searchTranscripts(validatedFields.data);
  if (
    !searchResults ||
    !searchResults.results ||
    searchResults.results.length === 0
  ) {
    return { error: "No results found" };
  }

  const transcripts = searchResults.results.map(
    (result: any) => result.Search_Doc_1
  );
  const formattedTranscripts = transcripts.join("\n\n");

  if (searchResults.results.length > 0) {
    const firstVideo = searchResults.results[0];
    console.log("Video object structure:", {
      ID: firstVideo.ID,
      Title: {
        value: firstVideo.Title,
        type: typeof firstVideo.Title,
      },
      Upload_Date: {
        value: firstVideo.Upload_Date,
        type: typeof firstVideo.Upload_Date,
        isDate: firstVideo.Upload_Date instanceof Date,
        stringified: JSON.stringify(firstVideo.Upload_Date),
      },
    });
  }

  let plainText = "";

  searchResults.results.forEach((video, index) => {
    // Extract title from video object, defaulting to Video_Title or Untitled if not present
    const title =
      video.Video_Title ||
      (typeof video.Title === "string" ? video.Title : "Untitled");

    // Extract and format the upload date, directly using the handling from VideoResult component
    const uploadDate =
      typeof video.Upload_Date === "object"
        ? (video.Upload_Date as any)?.value || "Unknown Date"
        : video.Upload_Date || "Unknown Date";

    plainText += `TITLE: ${title}\n`;
    plainText += `DATE: ${uploadDate}\n`;
    plainText += `TRANSCRIPT:\n${
      video.Search_Doc_1 || "No transcript available."
    }\n\n`;
    plainText += `-----------------------------------\n\n`;
  });

  // Return plain text data instead of a Response object
  const fileName = `search-results-${new Date()
    .toISOString()
    .slice(0, 10)}.txt`;
  return {
    plainText,
    fileName,
  };
}
