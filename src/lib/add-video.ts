// src/lib/add-video.ts
// ─────────────────────────────────────────────────────────────
//  Add one YouTube video to the library — the same steps as a /transcribe
//  submit (metadata → transcript → speakers → doc → BigQuery → search windows
//  → chat file), with `mode` deciding where the video itself lives:
//    "yt-only": nothing is downloaded or stored. video_source = 'youtube';
//               the editor plays the YouTube embed and exports fetch from
//               YouTube on demand.
// ─────────────────────────────────────────────────────────────

import { bigQuery } from "@/lib/bigquery";
import { TABLE_REFS } from "@/lib/bigquery-schema";

export type AddVideoEvent =
  | { step: string; status: "start" | "ok" | "warn"; detail?: string }
  | { step: "done"; status: "ok"; videoId: string; segments: number; speakerSource: string; editUrl: string }
  | { step: "error"; status: "error"; detail: string; failedStep?: string };

export interface VideoCheck {
  videoId: string;
  title: string;
  channel: string;
  lengthSeconds: number | null;
  publishedAt: string | null;
  suggestedSpeaker: string;
  existing: { video_source: string } | null;
  refusal: string | null; // why this video can't be added yt-only
}

function iso8601ToSec(d: string | undefined): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
  if (!m) return null;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
}

/** "Sam Altman, Co-Founder and CEO of OpenAI: …" → "Sam Altman" when the lead looks like a name. */
export function guessSpeaker(title: string): string {
  const lead = title.split(/\s*(?:,|:|\||—|–| - | on | with )\s*/i)[0]?.trim() || "";
  const words = lead.split(/\s+/);
  const isName = words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z][\p{L}'.-]+$/u.test(w));
  return isName ? lead : "";
}

export function extractId(input: string): string | null {
  const t = input.trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  const m = t.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

/** Title/channel/length plus whether yt-only can work (public, embeddable, not age-gated). */
export async function checkVideo(videoId: string): Promise<VideoCheck> {
  const key = process.env.YOUTUBE_API_KEY || "";
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,contentDetails,status&key=${key}`,
    { cache: "no-store" },
  );
  const data = await res.json().catch(() => ({}));
  const item = data.items?.[0];
  const [rows] = await bigQuery.query({
    query: `SELECT COALESCE(ANY_VALUE(video_source), 'bunny') AS video_source FROM ${TABLE_REFS.videos} WHERE video_id = @id HAVING COUNT(*) > 0`,
    params: { id: videoId },
  });
  const existing = rows[0] ? { video_source: rows[0].video_source as string } : null;
  if (!item) {
    return { videoId, title: "", channel: "", lengthSeconds: null, publishedAt: null, suggestedSpeaker: "", existing,
      refusal: "Video not found, private, or deleted — YouTube returns nothing for it." };
  }
  const st = item.status || {};
  const cd = item.contentDetails || {};
  let refusal: string | null = null;
  if (st.privacyStatus === "private") refusal = "Private video: RapidAPI and yt-dlp can't fetch it without cookies.";
  else if (cd.contentRating?.ytRating === "ytAgeRestricted") refusal = "Age-restricted video: RapidAPI and yt-dlp can't fetch it without cookies.";
  else if (st.embeddable === false) refusal = "The owner disabled embedding, so the editor can't play it.";
  else if (item.snippet?.liveBroadcastContent && item.snippet.liveBroadcastContent !== "none") refusal = "Live or upcoming stream — add it once the VOD is ready.";
  return {
    videoId,
    title: item.snippet?.title || "",
    channel: item.snippet?.channelTitle || "",
    lengthSeconds: iso8601ToSec(cd.duration),
    publishedAt: item.snippet?.publishedAt || null,
    suggestedSpeaker: guessSpeaker(item.snippet?.title || ""),
    existing,
    refusal,
  };
}

/** Runs the ingest, reporting each step through `emit`. */
export async function addVideoYtOnly(videoId: string, speaker: string, emit: (e: AddVideoEvent) => void) {
  const { fetchYoutubeMetadata, fetchYoutubeTranscript, createTranscriptDoc, addToBigQuery } = await import(
    "@/components/transcribe/utils/controller"
  );
  const { identifySpeakers, cleanSpeakerNames, formatTranscriptAsText } = await import("@/components/transcribe/utils/utils");
  const { uploadToVectorStore } = await import("@/components/transcribe/utils/vector-upload");
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  let step = "check";
  try {
    emit({ step, status: "start" });
    const check = await checkVideo(videoId);
    if (check.refusal) throw new Error(check.refusal);
    if (check.existing) throw new Error(`Already in the library (video_source=${check.existing.video_source}).`);
    emit({ step, status: "ok", detail: `${check.title} · ${check.channel}` });

    step = "metadata";
    emit({ step, status: "start" });
    const metadata: any = await fetchYoutubeMetadata(url, speaker);
    metadata.videoSource = "youtube";
    bigQuery.dataset("reptranscripts").table("transcribe_log").insert([{
      video_id: metadata.videoId,
      requested_at: new Date().toISOString(),
      speaker,
      video_title: metadata.title ?? null,
      channel_name: metadata.channelName ?? null,
      channel_id: metadata.channelId ?? null,
      published_date: metadata.publishedAt ? metadata.publishedAt.slice(0, 10) : null,
      duration_seconds: metadata.durationSeconds ?? null,
      youtube_link: `https://youtu.be/${metadata.videoId}`,
    }]).catch((err: unknown) => console.error("[add-video] transcribe_log insert failed:", err));
    emit({ step, status: "ok", detail: metadata.duration });

    step = "transcript";
    emit({ step, status: "start", detail: "Apify" });
    const transcript: any = await fetchYoutubeTranscript(url);
    if (transcript.error) throw new Error(transcript.error);
    const n = transcript.transcript_data?.length || 0;
    if (!n) throw new Error("Transcript came back empty");
    emit({ step, status: "ok", detail: `${n.toLocaleString("en-US")} segments (${transcript._source || "captions"})` });

    step = "speakers";
    emit({ step, status: "start" });
    try {
      const text = formatTranscriptAsText(transcript);
      metadata.speakersClaude = await identifySpeakers(text, metadata.title, metadata.description, speaker, metadata.channelName);
      metadata.speakersGptThird = cleanSpeakerNames(metadata.speakersClaude || "");
    } catch (e: any) {
      metadata.speakersClaude = null;
      metadata.speakersGptThird = null;
      emit({ step, status: "warn", detail: `speaker passes failed, keeping "${speaker}": ${e.message}` });
    }
    // The person this video was added for always stays on it.
    const has = (src: string) => src.split(",").some((s) => s.trim().toLowerCase() === speaker.trim().toLowerCase());
    const found = metadata.speakersGptThird || metadata.speakersClaude || "";
    if (!has(found)) metadata.speakersGptThird = found ? `${found}, ${speaker}` : speaker;
    emit({ step, status: "ok", detail: metadata.speakersGptThird });

    step = "doc";
    emit({ step, status: "start" });
    try {
      transcript.google_doc_url = await createTranscriptDoc(transcript, {
        videoId: metadata.videoId, title: metadata.title, speaker: metadata.speaker,
        channelName: metadata.channelName || undefined, publishedAt: metadata.publishedAt || undefined,
        language: transcript.language,
      });
      emit({ step, status: "ok" });
    } catch (e: any) {
      emit({ step, status: "warn", detail: `Google Doc skipped: ${e.message}` });
    }

    step = "bigquery";
    emit({ step, status: "start", detail: "row + segments, then search windows" });
    await addToBigQuery(transcript, metadata); // also rebuilds segment_search_windows
    emit({ step, status: "ok", detail: `${n.toLocaleString("en-US")} segments stored · search windows rebuilt` });

    step = "chat";
    emit({ step, status: "start" });
    const speakerSource = metadata.speakersGptThird || metadata.speakersClaude || speaker;
    await uploadToVectorStore({
      videoId: metadata.videoId, title: metadata.title, channel: metadata.channelName || "",
      publishedDate: metadata.publishedAt || null, duration: metadata.duration || null, speakerSource,
      languageCode: transcript.language_code || "en", segments: transcript.transcript_data || [],
    });
    emit({ step, status: "ok", detail: "chat file uploaded" });

    emit({ step: "done", status: "ok", videoId, segments: n, speakerSource, editUrl: `/edit?v=${videoId}` });
  } catch (e: any) {
    emit({ step: "error", status: "error", detail: e?.message || String(e), failedStep: step });
  }
}
