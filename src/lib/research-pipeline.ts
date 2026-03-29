/**
 * Standalone pipeline function extracted from singleExtract server action.
 * Can be called from API routes (not a server action).
 */

import {
  addToBigQuery,
  createTranscriptDoc,
  fetchYoutubeMetadata,
  fetchYoutubeTranscript,
} from "@/components/transcribe/utils/controller";
import {
  identifySpeakers,
  formatTranscriptAsText,
  verifyAndCleanSpeakers,
} from "@/components/transcribe/utils/utils";
import { uploadToVectorStore } from "@/components/transcribe/utils/vector-upload";

export interface PipelineResult {
  success: boolean;
  videoId: string;
  title?: string;
  error?: string;
  failedStep?: string;
}

export async function runPipeline(
  url: string,
  speaker: string
): Promise<PipelineResult> {
  let metadata: any;
  let transcript: any;

  // Step 1: Fetch metadata
  try {
    metadata = await fetchYoutubeMetadata(url, speaker);
  } catch (error: any) {
    return {
      success: false,
      videoId: "",
      error: error.message || "Failed to fetch metadata",
      failedStep: "metadata",
    };
  }

  // Step 2: Fetch transcript
  try {
    transcript = await fetchYoutubeTranscript(url);
    if (transcript.error) throw new Error(transcript.error);
  } catch (error: any) {
    return {
      success: false,
      videoId: metadata.videoId || "",
      title: metadata.title,
      error: error.message || "Failed to fetch transcript",
      failedStep: "transcript",
    };
  }

  // Step 3: AI speaker identification (2-pass)
  try {
    const transcriptText = formatTranscriptAsText(transcript);
    metadata.speakersClaude = await identifySpeakers(
      transcriptText,
      metadata.title,
      metadata.description,
      speaker,
      metadata.channelName
    );
    metadata.speakersGptThird = await verifyAndCleanSpeakers(
      transcriptText,
      metadata.title,
      metadata.description,
      speaker,
      metadata.speakersClaude || "",
      metadata.channelName
    );
  } catch (error) {
    console.error("Speaker identification failed (non-blocking):", error);
    metadata.speakersClaude = null;
    metadata.speakersGptThird = null;
  }

  // Step 4: Create Google Doc
  let googleDocUrl: string | undefined;
  try {
    googleDocUrl = await createTranscriptDoc(transcript, {
      videoId: metadata.videoId,
      title: metadata.title,
      speaker: metadata.speaker,
      channelName: metadata.channelName || undefined,
      publishedAt: metadata.publishedAt || undefined,
      language: transcript.language,
    });
    (transcript as any).google_doc_url = googleDocUrl;
  } catch (error: any) {
    return {
      success: false,
      videoId: metadata.videoId,
      title: metadata.title,
      error: error.message || "Failed to create Google Doc",
      failedStep: "google-doc",
    };
  }

  // Step 5: Add to BigQuery
  try {
    await addToBigQuery(transcript, metadata);
  } catch (error: any) {
    return {
      success: false,
      videoId: metadata.videoId,
      title: metadata.title,
      error: error.message || "Failed to add to BigQuery",
      failedStep: "bigquery",
    };
  }

  // Step 6: Upload to vector store
  const speakerSource =
    metadata.speakersGptThird ||
    metadata.speakersClaude ||
    metadata.speaker ||
    "";

  try {
    await uploadToVectorStore({
      videoId: metadata.videoId,
      title: metadata.title,
      channel: metadata.channelName || "",
      publishedDate: metadata.publishedAt || null,
      duration: metadata.duration || null,
      speakerSource,
      languageCode: transcript.language_code || "en",
      segments: transcript.transcript_data || [],
    });
  } catch (error: any) {
    console.error("Vector upload failed (non-blocking):", error.message);
    // Non-blocking — continue
  }

  // Step 7: Trigger GCS download (fire-and-forget)
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";
    fetch(`${baseUrl}/api/trigger-download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: metadata.videoId }),
    }).catch(() => {}); // fire-and-forget
  } catch {
    // Ignore GCS download failures
  }

  return {
    success: true,
    videoId: metadata.videoId,
    title: metadata.title,
  };
}
