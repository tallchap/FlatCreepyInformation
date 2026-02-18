import { z } from "zod";

export const videoResultSchema = z.object({
  ID: z.string(),
  Video_Title: z.string(),
  Channel_Name: z.string(),
  Published_Date: z.string(),
  Speakers: z.string(),
  Youtube_Link: z.string(),
  Video_Length: z.string(),
  Transcript_Doc_Link: z.string(),
  SearchTerm: z.string().optional(),
  MatchSnippets: z.array(z.object({ text: z.string(), seconds: z.number().nullable() })).optional(),
  Transcript: z.string().optional(),
  Search_Doc_1: z.string().optional(), // Full transcript content
});

export type VideoResult = z.infer<typeof videoResultSchema>;

// Schema for search results
export const searchResultsSchema = z.object({
  results: z.array(videoResultSchema),
  total: z.number(),
  uniqueVideos: z.number(),
});

export type SearchResults = z.infer<typeof searchResultsSchema>;
