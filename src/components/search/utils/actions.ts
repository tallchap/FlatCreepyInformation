"use server";

import { z } from "zod";
import { searchTranscripts } from "./controller";

const searchTranscriptSchema = z.object({
  searchQuery: z.string().optional(),
  speakerQuery: z.string().optional(),
  channelQuery: z.string().optional(),
  sortOrder: z.enum(["recent", "oldest"]),
  resultLimit: z.enum(["10", "100"]),
  yearFilter: z.string(),
});

export async function searchTranscript(formData: FormData) {
  const rawData = Object.fromEntries(formData);
  const validatedFields = searchTranscriptSchema.safeParse(rawData);
  if (!validatedFields.success) {
    return { error: "Invalid data" };
  }

  try {
    const searchResults = await searchTranscripts(validatedFields.data);
    return {
      ...searchResults,
      inputs: validatedFields.data,
    };
  } catch (error) {
    console.error(error);
    return {
      error:
        error instanceof Error ? error.message : "An unknown error occurred",
    };
  }
}

export async function exportTranscripts(inputs: Record<string, string>) {
  const validatedFields = searchTranscriptSchema.safeParse(inputs);
  if (!validatedFields.success) {
    return { error: "Invalid data" };
  }
  const searchResults = await searchTranscripts(validatedFields.data);
  if (!searchResults.results || searchResults.results.length === 0) {
    return { error: "No results found" };
  }

  if (searchResults.results.length > 0) {
    const firstVideo = searchResults.results[0];
    console.log("Video object structure:", {
      ID: firstVideo.ID,
      Title: {
        value: firstVideo.Title,
        type: typeof firstVideo.Title,
      },
      Published_Date: {
        value: firstVideo.Published_Date,
        type: typeof firstVideo.Published_Date,
        isDate: firstVideo.Published_Date instanceof Date,
        stringified: JSON.stringify(firstVideo.Published_Date),
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
      typeof video.Published_Date === "object"
        ? (video.Published_Date as any)?.value || "Unknown Date"
        : video.Published_Date || "Unknown Date";

    plainText += `TITLE: ${title}\n`;
    plainText += `DATE: ${uploadDate}\n`;
    plainText += `TRANSCRIPT:\n${(
      video.Search_Doc_1 || "No transcript available."
    ).replace(/\n\n/g, "\n")}\n\n`;
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
