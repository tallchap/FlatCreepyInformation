/**
 * Research processing pipeline.
 * Uses metadata + transcript already in research_candidates (from discovery Phase 4).
 * All steps must succeed. Each step writes audit data + detailed log to processing_steps_json.
 */

import {
  addToBigQuery,
} from "@/components/transcribe/utils/controller";
import {
  identifySpeakers,
  formatTranscriptAsText,
  verifyAndCleanSpeakers,
} from "@/components/transcribe/utils/utils";
import { uploadToVectorStore } from "@/components/transcribe/utils/vector-upload";
import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS } from "@/lib/bigquery-schema";

export interface PipelineResult {
  success: boolean;
  videoId: string;
  title?: string;
  error?: string;
  failedStep?: string;
  steps?: Record<string, any>;
}

function ts() { return new Date().toLocaleTimeString(); }

const dataset = bigQuery.dataset("reptranscripts");
const logTable = dataset.table("research_candidate_processing");

// Streaming insert to log table (no DML limit) for live progress
async function updateStepProgress(runId: string, videoId: string, step: string, steps: Record<string, any>) {
  try {
    await logTable.insert({
      run_id: runId,
      video_id: videoId,
      status: "processing",
      step,
      steps_json: JSON.stringify(steps),
      error: "",
      created_at: new Date().toISOString(),
    }, { ignoreUnknownValues: true });
  } catch {}
}

// Single DML UPDATE to research_candidates — only called once at the very end
async function finalizeCandidate(runId: string, videoId: string, status: string, error: string, step: string, steps: Record<string, any>) {
  try {
    await bigQuery.query({
      query: `UPDATE ${TABLE_REFS.researchCandidates}
              SET processing_status = @status, processing_error = @error,
                  processing_step = @step, processing_steps_json = @stepsJson,
                  processed_at = CURRENT_TIMESTAMP()
              WHERE run_id = @runId AND video_id = @videoId`,
      params: { status, error, step, stepsJson: JSON.stringify(steps), runId, videoId },
    });
  } catch {}
}

export async function runPipeline(
  url: string,
  speaker: string,
  preloadedTranscript?: any,
  preloadedMetadata?: any,
  runId?: string
): Promise<PipelineResult> {
  const videoId = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1] || "";
  const steps: Record<string, any> = {};

  // Build metadata
  const durationSec = preloadedMetadata?.duration_seconds || 0;
  const h = Math.floor(durationSec / 3600);
  const m = Math.floor((durationSec % 3600) / 60);
  const s = durationSec % 60;
  const durationStr = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;

  const metadata: any = {
    videoId,
    title: preloadedMetadata?.title || "",
    channelName: preloadedMetadata?.channel || "",
    channelId: preloadedMetadata?.channel_id || "",
    duration: durationStr,
    publishedAt: preloadedMetadata?.published_at || new Date().toISOString().split("T")[0],
    description: preloadedMetadata?.description || "",
    thumbnailUrl: preloadedMetadata?.thumbnail_url || "",
    cleanUrl: `https://www.youtube.com/watch?v=${videoId}`,
    speaker,
    userSpeakers: speaker,
    viewCount: 0,
    extractedNames: null,
    speakersClaude: null,
    speakersGptThird: null,
  };

  const transcript = preloadedTranscript;
  if (!transcript || !transcript.transcript_data?.length) {
    steps.bigquery = { status: "skipped", log: [`[${ts()}] No transcript available — skipping all steps`] };
    steps.speaker_id = { status: "skipped" };
    steps.vector_store = { status: "skipped" };
    steps.gcs_download = { status: "skipped" };
    if (runId) await finalizeCandidate(runId, videoId, "failed", "No transcript available from research phase", "failed", steps);
    return { success: false, videoId, title: metadata.title, error: "No transcript available from research phase", failedStep: "transcript", steps };
  }

  const segmentCount = (transcript.transcript_data || []).length;

  // ── Step 1: BigQuery ──
  const bqLog: string[] = [];
  if (runId) await updateStepProgress(runId, videoId, "bigquery", steps);
  try {
    const t0 = Date.now();
    bqLog.push(`[${ts()}] Starting BigQuery insert for ${videoId}`);
    bqLog.push(`[${ts()}] Transcript: ${segmentCount} segments`);
    bqLog.push(`[${ts()}] DELETE existing rows from youtube_videos, youtube_transcript_segments`);
    await addToBigQuery(transcript, metadata);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    bqLog.push(`[${ts()}] INSERT youtube_transcripts (legacy) → 1 row`);
    bqLog.push(`[${ts()}] INSERT youtube_videos → 1 row`);
    bqLog.push(`[${ts()}] INSERT youtube_transcript_segments → ${segmentCount} rows`);
    bqLog.push(`[${ts()}] Complete in ${elapsed}s`);
    steps.bigquery = {
      status: "complete", timestamp: new Date().toISOString(),
      tables: ["youtube_transcripts", "youtube_videos", "youtube_transcript_segments"],
      segment_count: segmentCount, log: bqLog,
    };
    if (runId) await updateStepProgress(runId, videoId, "bigquery", steps);
  } catch (error: any) {
    bqLog.push(`[${ts()}] FAILED: ${error.message}`);
    steps.bigquery = { status: "failed", error: error.message, timestamp: new Date().toISOString(), log: bqLog };
    steps.speaker_id = { status: "skipped" };
    steps.vector_store = { status: "skipped" };
    steps.gcs_download = { status: "skipped" };
    if (runId) await finalizeCandidate(runId, videoId, "failed", error.message, "failed", steps);
    return { success: false, videoId, title: metadata.title, error: error.message, failedStep: "bigquery", steps };
  }

  // ── Step 2: Speaker ID ──
  const idLog: string[] = [];
  if (runId) await updateStepProgress(runId, videoId, "speaker-id", steps);
  try {
    const t0 = Date.now();
    const transcriptText = formatTranscriptAsText(transcript);
    idLog.push(`[${ts()}] Formatted transcript: ${transcriptText.length} chars`);

    idLog.push(`[${ts()}] Claude identifySpeakers() called...`);
    const t1 = Date.now();
    metadata.speakersClaude = await identifySpeakers(transcriptText, metadata.title, metadata.description, speaker, metadata.channelName);
    idLog.push(`[${ts()}] Claude response: "${metadata.speakersClaude}" (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

    idLog.push(`[${ts()}] GPT verifyAndCleanSpeakers() called...`);
    const t2 = Date.now();
    metadata.speakersGptThird = await verifyAndCleanSpeakers(transcriptText, metadata.title, metadata.description, speaker, metadata.speakersClaude || "", metadata.channelName);
    idLog.push(`[${ts()}] GPT response: "${metadata.speakersGptThird}" (${((Date.now() - t2) / 1000).toFixed(1)}s)`);

    const finalSpeakers = metadata.speakersGptThird || metadata.speakersClaude || speaker;
    idLog.push(`[${ts()}] Final speakers: "${finalSpeakers}"`);

    idLog.push(`[${ts()}] UPDATE youtube_transcripts SET Speakers_Claude, Speakers_GPT_Third`);
    try {
      await bigQuery.query({
        query: `UPDATE ${TABLE_REFS.legacyTranscripts} SET Speakers_Claude = @claude, Speakers_GPT_Third = @gpt WHERE ID = @videoId`,
        params: { claude: metadata.speakersClaude || "", gpt: metadata.speakersGptThird || "", videoId },
      });
      idLog.push(`[${ts()}] BigQuery updated`);
    } catch (e: any) {
      idLog.push(`[${ts()}] BigQuery update failed (non-fatal): ${e.message}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    idLog.push(`[${ts()}] Complete in ${elapsed}s`);
    steps.speaker_id = {
      status: "complete", timestamp: new Date().toISOString(),
      claude_pass: metadata.speakersClaude || "", gpt_pass: metadata.speakersGptThird || "",
      final: finalSpeakers, log: idLog,
    };
    if (runId) await updateStepProgress(runId, videoId, "speaker-id", steps);
  } catch (error: any) {
    idLog.push(`[${ts()}] FAILED: ${error.message}`);
    steps.speaker_id = { status: "failed", error: error.message, timestamp: new Date().toISOString(), log: idLog };
    steps.vector_store = { status: "skipped" };
    steps.gcs_download = { status: "skipped" };
    if (runId) await finalizeCandidate(runId, videoId, "failed", error.message, "failed", steps);
    return { success: false, videoId, title: metadata.title, error: error.message, failedStep: "speaker-id", steps };
  }

  // ── Step 3: Vector store ──
  const vecLog: string[] = [];
  if (runId) await updateStepProgress(runId, videoId, "vector-store", steps);
  const speakerSource = metadata.speakersGptThird || metadata.speakersClaude || speaker;
  try {
    const t0 = Date.now();
    const segments = transcript.transcript_data || [];
    const allSpeakers = speakerSource.split(",").map((s: string) => s.trim()).filter(Boolean);
    vecLog.push(`[${ts()}] Uploading to vector store for ${allSpeakers.length} speaker(s): ${allSpeakers.join(", ")}`);
    vecLog.push(`[${ts()}] ${segments.length} segments → ~${Math.ceil(segments.length / 10)} chunks`);

    await uploadToVectorStore({
      videoId, title: metadata.title, channel: metadata.channelName || "",
      publishedDate: metadata.publishedAt || null, duration: metadata.duration || null,
      speakerSource, languageCode: transcript.language_code || "en", segments,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    vecLog.push(`[${ts()}] Upload complete in ${elapsed}s`);
    steps.vector_store = {
      status: "complete", timestamp: new Date().toISOString(),
      chunks_uploaded: Math.ceil(segments.length / 10), speakers_indexed: allSpeakers, log: vecLog,
    };
    if (runId) await updateStepProgress(runId, videoId, "vector-store", steps);
  } catch (error: any) {
    vecLog.push(`[${ts()}] FAILED: ${error.message}`);
    steps.vector_store = { status: "failed", error: error.message, timestamp: new Date().toISOString(), log: vecLog };
    steps.gcs_download = { status: "skipped" };
    if (runId) await finalizeCandidate(runId, videoId, "failed", error.message, "failed", steps);
    return { success: false, videoId, title: metadata.title, error: error.message, failedStep: "vector-store", steps };
  }

  // ── Step 4: GCS download ──
  const gcsLog: string[] = [];
  if (runId) await updateStepProgress(runId, videoId, "gcs-download", steps);
  try {
    const t0 = Date.now();
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3001";
    gcsLog.push(`[${ts()}] POST ${baseUrl}/api/trigger-download { videoId: "${videoId}" }`);

    const res = await fetch(`${baseUrl}/api/trigger-download`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
    if (!res.ok) throw new Error(`trigger-download returned ${res.status}`);
    const data = await res.json();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    gcsLog.push(`[${ts()}] Cloud Run execution: ${data.execution || "unknown"}`);
    gcsLog.push(`[${ts()}] Complete in ${elapsed}s`);
    steps.gcs_download = {
      status: "complete", timestamp: new Date().toISOString(),
      execution_id: data.execution || "", video_id: videoId, log: gcsLog,
    };
    if (runId) await updateStepProgress(runId, videoId, "gcs-download", steps);
  } catch (error: any) {
    gcsLog.push(`[${ts()}] FAILED: ${error.message}`);
    steps.gcs_download = { status: "failed", error: error.message, timestamp: new Date().toISOString(), log: gcsLog };
    if (runId) await finalizeCandidate(runId, videoId, "failed", error.message, "failed", steps);
    return { success: false, videoId, title: metadata.title, error: error.message, failedStep: "gcs-download", steps };
  }

  // Final: one DML UPDATE to mark complete
  if (runId) await finalizeCandidate(runId, videoId, "complete", "", "gcs-download", steps);

  return { success: true, videoId, title: metadata.title, steps };
}
