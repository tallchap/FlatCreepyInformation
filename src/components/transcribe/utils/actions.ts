"use server";

import { z } from "zod";
import {
  addMetadataToSheet,
  addToBigQuery,
  createTranscriptDoc,
  fetchYoutubeMetadata,
  fetchYoutubeTranscript,
} from "./controller";
import {
  identifySpeakers,
  formatTranscriptAsText,
  verifyAndCleanSpeakers,
} from "./utils";
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
  let metadata;
  try {
    metadata = await fetchYoutubeMetadata(url, speaker);
  } catch (error: any) {
    console.error("Error fetching metadata:", error);
    return {
      error: error.message || "Error fetching metadata",
    };
  }
  let transcript;
  try {
    transcript = await fetchYoutubeTranscript(url);
    if (transcript.error) {
      throw new Error(transcript.error);
    }
  } catch (error: any) {
    console.error("Error fetching transcript:", error);
    return {
      videoTitle: metadata.title,
      youtubeLink: metadata.cleanUrl,
      status: "failed",
      failedStep: "transcript",
      errorMessage: error?.message || "Failed to fetch transcript",
    };
  }

  // AI speaker identification using transcript content
  try {
    const transcriptText = formatTranscriptAsText(transcript);
    (metadata as any).speakersClaude = await identifySpeakers(
      transcriptText,
      metadata.title,
      metadata.description,
      speaker,
      metadata.channelName
    );

    (metadata as any).speakersGptThird = await verifyAndCleanSpeakers(
      transcriptText,
      metadata.title,
      metadata.description,
      speaker,
      (metadata as any).speakersClaude || "",
      metadata.channelName
    );

    console.log(`AI-identified speakers (pass 2): ${(metadata as any).speakersClaude}`);
    console.log(`AI-identified speakers (pass 3): ${(metadata as any).speakersGptThird}`);
  } catch (error) {
    console.error("Error in AI speaker identification:", error);
    (metadata as any).speakersClaude = null;
    (metadata as any).speakersGptThird = null;
  }

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
      } catch (error: any) {
        console.error("Error adding to BigQuery:", error);
        return {
          videoTitle: metadata.title,
          youtubeLink: metadata.cleanUrl,
          googleDocUrl,
          status: "failed",
          failedStep: "bigquery",
          errorMessage: error?.message || "Failed to add to BigQuery",
        };
      }

    }
    if (store_in_sheet) {
      try {
        await addMetadataToSheet(metadata, googleDocUrl);
      } catch (error: any) {
        console.error("Error adding to Sheets:", error);
        return {
          videoTitle: metadata.title,
          youtubeLink: metadata.cleanUrl,
          googleDocUrl,
          status: "failed",
          failedStep: "sheets",
          errorMessage: error?.message || "Failed to add to Sheets",
        };
      }
    }
    const speakerSource =
      (metadata as any).speakersGptThird ||
      (metadata as any).speakersClaude ||
      metadata.speaker ||
      "";

    return {
      videoTitle: metadata.title,
      youtubeLink: metadata.cleanUrl,
      googleDocUrl,
      status: "vectorizing",
      vectorData: {
        videoId: metadata.videoId,
        title: metadata.title,
        channel: metadata.channelName || "",
        publishedDate: metadata.publishedAt || null,
        duration: metadata.duration || null,
        speakerSource,
        languageCode: transcript.language_code || "en",
        segments: transcript.transcript_data || [],
      },
    };
  } catch (error: any) {
    console.error("Error in singleExtract:", error);
    return {
      videoTitle: metadata.title,
      youtubeLink: metadata.cleanUrl,
      status: "failed",
      failedStep: "google-doc",
      errorMessage: error?.message || "Failed to create Google Doc",
    };
  }
}
