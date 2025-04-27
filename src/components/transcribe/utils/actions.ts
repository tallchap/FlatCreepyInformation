"use server";

import { z } from "zod";
import {
  addMetadataToSheet,
  addToBigQuery,
  createTranscriptDoc,
  fetchYoutubeMetadata,
  fetchYoutubeTranscript,
} from "./controller";

const singleExtractSchema = z.object({
  url: z.string().url(),
  speaker: z.string().min(1),
  store_in_bigquery: z.enum(["on"]).optional(),
  store_in_sheet: z.enum(["on"]).optional(),
});

export async function singleExtract(prevState: any, formData: FormData) {
  const rawData = Object.fromEntries(formData);
  const validatedFields = singleExtractSchema.safeParse(rawData);
  if (!validatedFields.success) {
    return { error: "Invalid fields" };
  }

  const { url, speaker, store_in_bigquery, store_in_sheet } =
    validatedFields.data;

  console.log(`Extracting metadata for: ${url}`);
  const metadata = await fetchYoutubeMetadata(url, speaker);
  let transcript;
  try {
    transcript = await fetchYoutubeTranscript(url);
    if (transcript.error) {
      throw new Error(transcript.error);
    }
  } catch (error) {
    console.error("Error fetching transcript:", error);
    return {
      videoTitle: metadata.title,
      youtubeLink: metadata.cleanUrl,
      status: "failed",
    };
  }

  // const textTranscript = formatTranscriptAsText(transcript);
  // const srtTranscript = formatTranscriptAsSRT(transcript);

  let googleDocUrl;
  try {
    console.log("Creating Google Doc with transcript...");
    // Log metadata object to see what we have available
    console.log("Metadata being passed to Google Doc service:", {
      videoId: metadata.videoId,
      title: metadata.title,
      speaker: metadata.speaker,
      channelName: metadata.channelName,
    });

    // Explicitly pass videoId and language to the Google Doc service
    googleDocUrl = await createTranscriptDoc(transcript, {
      videoId: metadata.videoId, // Include the videoId explicitly
      title: metadata.title,
      speaker: metadata.speaker,
      channelName: metadata.channelName || undefined,
      publishedAt: metadata.publishedAt || undefined,
      language: transcript.language, // Pass the language from transcript
    });

    // Add the Google Doc URL to the transcript object
    // Type assertion to handle the dynamic property
    (transcript as any).google_doc_url = googleDocUrl;

    console.log(`Google Doc created: ${googleDocUrl}`);

    // Step 5: Now that we have the Google Doc URL, we can add to BigQuery with all data
    if (store_in_bigquery) {
      try {
        await addToBigQuery(transcript, metadata);
      } catch (error) {
        console.error("Error adding to BigQuery:", error);
        return {
          videoTitle: metadata.title,
          youtubeLink: metadata.cleanUrl,
          googleDocUrl,
          status: "failed",
        };
      }
    }
    if (store_in_sheet) {
      try {
        await addMetadataToSheet(metadata, googleDocUrl);
      } catch (error) {
        console.error("Error adding to Sheets:", error);
        return {
          videoTitle: metadata.title,
          youtubeLink: metadata.cleanUrl,
          googleDocUrl,
          status: "failed",
        };
      }
    }
    return {
      videoTitle: metadata.title,
      youtubeLink: metadata.cleanUrl,
      googleDocUrl,
      status: "success",
    };
  } catch (error) {
    console.error("Error in singleExtract:", error);
    return {
      videoTitle: metadata.title,
      youtubeLink: metadata.cleanUrl,
      status: "failed",
    };
  }
}
