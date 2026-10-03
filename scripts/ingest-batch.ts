#!/usr/bin/env npx tsx
/**
 * Bulk-ingest YouTube videos into Snippysaurus — the same steps as one
 * /transcribe submit, run from a terminal instead of a browser tab.
 *
 * Phase "videos": for each ID with no ready Bunny asset —
 *   - if gs://snippysaurus-clips/videos/{id}.mp4 holds a real video (an older
 *     research batch put it there), Bunny fetches it straight from GCS;
 *   - otherwise fire one `bunny-downloader` Cloud Run execution (RapidAPI
 *     1080p → 720p fallback → Bunny fetch). One execution per video, so a task
 *     retry can only ever re-download that one video.
 *   The downloader skips any ID already in GCS even in bunny-only mode, which
 *   is why the GCS case is handled here. Whatever is still missing or below
 *   1080p afterwards goes to scripts/ytdlp-to-bunny.py (run on Shadow).
 * Phase "transcripts": for each ID not already in youtube_videos —
 *   metadata → transcribe_log → transcript → speaker passes 2+3 → Google Doc →
 *   BigQuery → vector store. The search-window table is rebuilt once at the end.
 * Phase "verify" (runs last; or alone with --only verify): per video, checks
 *   BigQuery row + segments, speaker in speaker_source, a vector-store (chat)
 *   file for the speaker, and a finished Bunny video. Exits 1 if anything is
 *   missing. --repair fixes the speaker field and uploads missing chat files.
 *
 * --confirmed-speaker: the speaker is already confirmed in every video (e.g. by
 *   the research server's judge). The GPT speaker passes only read the first
 *   20k characters, so on long shows they drop a guest who appears later; this
 *   flag keeps the speaker in speaker_source regardless.
 *
 * Usage:
 *   npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "Max Tegmark"
 *   npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "..." --only videos
 *   npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "..." --only transcripts --concurrency 4
 *   npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "..." --dry-run
 *   npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "..." --only transcripts --transcripts-dir dir/
 *   npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "..." --only verify [--repair]
 *   npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "..." --only respeaker [--dry-run]
 *
 * ids.txt: one YouTube video ID or URL per line (# comments allowed).
 * Requires .env.local with GOOGLE_APPLICATION_CREDENTIALS_JSON, YOUTUBE_API_KEY,
 * APIFY_TOKEN, OPENAI_API_KEY, BUNNY_STREAM_API_KEY.
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";

config({ path: path.resolve(__dirname, "../.env.local") });

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const IDS_FILE = arg("ids");
const SPEAKER = arg("speaker");
const ONLY = arg("only"); // "videos" | "transcripts" | "verify" | null (all)
const CONCURRENCY = Number(arg("concurrency") || 3);
const TRIGGER_GAP_MS = Number(arg("trigger-gap-ms") || 10000);
const DRY_RUN = process.argv.includes("--dry-run");
const CONFIRMED_SPEAKER = process.argv.includes("--confirmed-speaker");
const REPAIR = process.argv.includes("--repair");
// Directory of <videoId>.json transcripts to use instead of fetching (e.g. ElevenLabs
// Scribe output for videos with no English captions). Same shape as fetchYoutubeTranscript.
const TRANSCRIPTS_DIR = arg("transcripts-dir");
const SHARED_VECTOR_STORE_ID = "vs_69b1015315d88191b6f26c169575bc4c";

const PROJECT = "youtubetranscripts-429803";
const REGION = "us-central1";
const JOB = "bunny-downloader";
const BUNNY_LIBRARY_ID = "627230";

if (!IDS_FILE || !SPEAKER) {
  console.error('Usage: npx tsx scripts/ingest-batch.ts --ids <file> --speaker "<name>" [--only videos|transcripts] [--concurrency N] [--dry-run]');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p: Promise<void> = fn(item).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

async function main() {
  // Imported after dotenv so the shared clients see the env vars.
  const { extractVideoId } = await import("../src/components/transcribe/utils/utils");
  const { bigQuery } = await import("../src/lib/bigquery");

  const ids = [
    ...new Set(
      fs
        .readFileSync(IDS_FILE!, "utf8")
        .split("\n")
        .map((l) => l.replace(/#.*/, "").trim())
        .filter(Boolean)
        .map((l) => (/^[\w-]{11}$/.test(l) ? l : extractVideoId(l)))
        .filter((v): v is string => !!v),
    ),
  ];
  console.log(`${ids.length} video IDs, speaker hint "${SPEAKER}"${DRY_RUN ? " (dry run)" : ""}\n`);

  const summary: Record<string, string[]> = {};
  const note = (bucket: string, id: string) => (summary[bucket] ||= []).push(id);

  if (!ONLY || ONLY === "videos") await videosPhase(ids, note);
  if (!ONLY || ONLY === "transcripts") await transcriptsPhase(ids, note, bigQuery);
  if (ONLY === "respeaker") await respeakerPhase(ids, note, bigQuery);
  if (!DRY_RUN && (!ONLY || ONLY === "verify" || ONLY === "transcripts")) await verifyPhase(ids, note, bigQuery);

  console.log("\n=== SUMMARY ===");
  for (const [bucket, list] of Object.entries(summary)) {
    console.log(`${bucket}: ${list.length}${list.length <= 20 ? "  " + list.join(" ") : ""}`);
  }
  const red = ["transcript-failed", "video-trigger-failed", "verify-red"];
  if (red.some((b) => summary[b]?.length)) process.exitCode = 1;
}

// ── Phase: videos ───────────────────────────────────────────────────────

async function bunnyStatus(videoId: string): Promise<{ ready: boolean; inFlight: boolean }> {
  const key = (process.env.BUNNY_STREAM_API_KEY || "").trim();
  const res = await fetch(
    `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?search=${videoId}&itemsPerPage=10`,
    { headers: { AccessKey: key } },
  );
  if (!res.ok) throw new Error(`Bunny search ${res.status}`);
  const data = await res.json();
  const matches = (data.items || []).filter((v: any) => v.title === videoId);
  // status 4 = finished; 0-3 = queued/processing/encoding; 5/6 = failed
  return {
    ready: matches.some((v: any) => v.status === 4),
    inFlight: matches.some((v: any) => v.status >= 0 && v.status <= 3),
  };
}

const GCS_PUBLIC = "https://storage.googleapis.com/snippysaurus-clips/videos";

// Height of the GCS copy's video stream; 0 if the file has no video stream;
// null if there is no GCS copy. Needs ffprobe on PATH.
async function gcsVideoHeight(videoId: string): Promise<number | null> {
  const head = await fetch(`${GCS_PUBLIC}/${videoId}.mp4`, { method: "HEAD" });
  if (!head.ok) return null;
  const { execFile } = await import("child_process");
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", `${GCS_PUBLIC}/${videoId}.mp4`],
      { timeout: 60000 },
      (err, stdout) => resolve(err ? null : Number(String(stdout).trim()) || 0),
    );
  });
}

async function videosPhase(ids: string[], note: (b: string, id: string) => void) {
  console.log("── Videos: Bunny check + Cloud Run triggers ──");
  const { google } = await import("googleapis");
  const { parseServiceAccount } = await import("../src/lib/bigquery");
  const creds = parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  for (const videoId of ids) {
    try {
      const s = await bunnyStatus(videoId);
      if (s.ready || s.inFlight) {
        console.log(`  [${videoId}] skip: Bunny ${s.ready ? "already has it" : "is already encoding it"}`);
        note("video-already-in-bunny", videoId);
        continue;
      }
      const gcs = await gcsVideoHeight(videoId);
      if (gcs) {
        if (DRY_RUN) {
          console.log(`  [${videoId}] would have Bunny fetch the ${gcs}p GCS copy`);
          note("video-would-fetch-gcs", videoId);
          continue;
        }
        const res = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/fetch`, {
          method: "POST",
          headers: { AccessKey: (process.env.BUNNY_STREAM_API_KEY || "").trim(), "Content-Type": "application/json" },
          body: JSON.stringify({ url: `${GCS_PUBLIC}/${videoId}.mp4`, title: videoId }),
        });
        if (!res.ok) throw new Error(`Bunny fetch from GCS ${res.status}: ${(await res.text()).slice(0, 200)}`);
        console.log(`  [${videoId}] Bunny fetching ${gcs}p copy from GCS`);
        note("video-fetched-from-gcs", videoId);
        continue;
      }
      if (gcs === 0) {
        // The GCS file exists but has no video stream. The downloader would skip
        // this ID because the file exists, so leave it for the yt-dlp fallback.
        console.log(`  [${videoId}] GCS copy has no video stream — left for scripts/ytdlp-to-bunny.py`);
        note("video-needs-ytdlp", videoId);
        continue;
      }
      if (DRY_RUN) {
        console.log(`  [${videoId}] would trigger ${JOB}`);
        note("video-would-trigger", videoId);
        continue;
      }
      const token = await auth.getAccessToken();
      const res = await fetch(
        `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            overrides: {
              taskCount: 1,
              containerOverrides: [
                {
                  env: [
                    { name: "MODE", value: "bunny-only" },
                    { name: "VIDEO_ID", value: videoId },
                    { name: "BATCH_SIZE", value: "1" },
                    { name: "MAX_CONCURRENT", value: "1" },
                  ],
                },
              ],
            },
          }),
        },
      );
      if (!res.ok) throw new Error(`Cloud Run ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      console.log(`  [${videoId}] triggered → ${data.metadata?.name || data.name}`);
      note("video-triggered", videoId);
      await sleep(TRIGGER_GAP_MS); // spread RapidAPI inits out
    } catch (e: any) {
      console.error(`  [${videoId}] video trigger FAILED: ${e.message}`);
      note("video-trigger-failed", videoId);
    }
  }
  console.log();
}

// ── Phase: transcripts ──────────────────────────────────────────────────

async function transcriptsPhase(ids: string[], note: (b: string, id: string) => void, bigQuery: any) {
  console.log("── Transcripts: metadata → transcript → speakers → doc → BigQuery → vector store ──");
  const { fetchYoutubeMetadata, fetchYoutubeTranscript, createTranscriptDoc, addToBigQuery } = await import(
    "../src/components/transcribe/utils/controller"
  );
  const { identifySpeakers, verifyAndCleanSpeakers, formatTranscriptAsText } = await import(
    "../src/components/transcribe/utils/utils"
  );
  const { uploadToVectorStore } = await import("../src/components/transcribe/utils/vector-upload");

  const [rows] = await bigQuery.query({
    query: `SELECT DISTINCT video_id FROM \`${PROJECT}.reptranscripts.youtube_videos\` WHERE video_id IN UNNEST(@ids)`,
    params: { ids },
  });
  const existing = new Set(rows.map((r: any) => r.video_id));
  const todo = ids.filter((id) => !existing.has(id));
  for (const id of existing) note("transcript-already-in-bigquery", id as string);
  console.log(`  ${existing.size} already in youtube_videos, ${todo.length} to ingest\n`);
  if (DRY_RUN) {
    todo.forEach((id) => note("transcript-would-ingest", id));
    return;
  }

  // Search windows are rebuilt once at the end; per-video rebuilds would run
  // CREATE OR REPLACE concurrently and collide.
  process.env.SKIP_SEARCH_WINDOW_REBUILD = "true";

  await runPool(todo, CONCURRENCY, async (videoId) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const t0 = Date.now();
    try {
      const metadata: any = await fetchYoutubeMetadata(url, SPEAKER!);

      await bigQuery
        .dataset("reptranscripts")
        .table("transcribe_log")
        .insert([
          {
            video_id: metadata.videoId,
            requested_at: new Date().toISOString(),
            speaker: SPEAKER,
            video_title: metadata.title ?? null,
            channel_name: metadata.channelName ?? null,
            channel_id: metadata.channelId ?? null,
            published_date: metadata.publishedAt ? metadata.publishedAt.slice(0, 10) : null,
            duration_seconds: metadata.durationSeconds ?? null,
            youtube_link: `https://youtu.be/${metadata.videoId}`,
          },
        ])
        .catch((err: unknown) => console.error(`  [${videoId}] transcribe_log insert failed:`, err));

      const local = TRANSCRIPTS_DIR && path.join(TRANSCRIPTS_DIR, `${videoId}.json`);
      const transcript: any =
        local && fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, "utf8")) : await fetchYoutubeTranscript(url);
      if (local && fs.existsSync(local)) console.log(`  [${videoId}] using local transcript ${local} (${transcript._source})`);
      if (transcript.error) throw new Error(transcript.error);

      try {
        const text = formatTranscriptAsText(transcript);
        metadata.speakersClaude = await identifySpeakers(
          text, metadata.title, metadata.description, SPEAKER!, metadata.channelName,
        );
        metadata.speakersGptThird = await verifyAndCleanSpeakers(
          text, metadata.title, metadata.description, SPEAKER!, metadata.speakersClaude || "", metadata.channelName,
        );
      } catch (e: any) {
        console.error(`  [${videoId}] speaker ID failed (falling back to "${SPEAKER}"): ${e.message}`);
        metadata.speakersClaude = null;
        metadata.speakersGptThird = null;
      }
      if (CONFIRMED_SPEAKER) {
        const current = metadata.speakersGptThird || metadata.speakersClaude || "";
        if (!hasSpeaker(current, SPEAKER!)) {
          console.log(`  [${videoId}] speaker passes dropped "${SPEAKER}" (${current || "none"}) — keeping it (--confirmed-speaker)`);
          metadata.speakersGptThird = current ? `${current}, ${SPEAKER}` : SPEAKER;
        }
      }

      transcript.google_doc_url = await createTranscriptDoc(transcript, {
        videoId: metadata.videoId,
        title: metadata.title,
        speaker: metadata.speaker,
        channelName: metadata.channelName || undefined,
        publishedAt: metadata.publishedAt || undefined,
        language: transcript.language,
      });

      await addToBigQuery(transcript, metadata);

      const speakerSource = metadata.speakersGptThird || metadata.speakersClaude || metadata.speaker || "";
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
      } catch (e: any) {
        console.error(`  [${videoId}] vector upload failed (non-blocking): ${e.message}`);
        note("vector-upload-failed", videoId);
      }

      const secs = Math.round((Date.now() - t0) / 1000);
      console.log(
        `  [${videoId}] OK in ${secs}s — ${transcript.transcript_data?.length || 0} segments, speakers: ${speakerSource}`,
      );
      note("transcript-ingested", videoId);
    } catch (e: any) {
      console.error(`  [${videoId}] transcript FAILED: ${e.message}`);
      note("transcript-failed", videoId);
    }
  });

  console.log("\n  Rebuilding segment_search_windows once...");
  const { rebuildSearchWindows } = await import("../src/components/transcribe/utils/controller");
  await rebuildSearchWindows();
}

// ── Phase: respeaker ────────────────────────────────────────────────────
// Re-runs the GPT speaker passes on stored transcripts, for videos ingested while
// they were failing (OpenAI out of credits, 2026-10-01). Keeps --speaker, updates
// speaker_source, and uploads chat files only for speakers that are new.

async function respeakerPhase(ids: string[], note: (b: string, id: string) => void, bigQuery: any) {
  console.log(`── Respeaker${DRY_RUN ? " (dry run)" : ""}: speaker passes on stored transcripts ──`);
  const { fetchYoutubeMetadata } = await import("../src/components/transcribe/utils/controller");
  const { identifySpeakers, verifyAndCleanSpeakers, formatTranscriptAsText } = await import(
    "../src/components/transcribe/utils/utils"
  );
  const { uploadToVectorStore } = await import("../src/components/transcribe/utils/vector-upload");
  const split = (x: string | null | undefined) => (x || "").split(",").map((s) => s.trim()).filter(Boolean);

  await runPool(ids, CONCURRENCY, async (id) => {
    try {
      const [[r]] = await bigQuery.query({
        query: `SELECT ANY_VALUE(speaker_source) AS speaker_source, ANY_VALUE(video_title) AS title, ANY_VALUE(channel_name) AS channel,
                  ANY_VALUE(CAST(published_date AS STRING)) AS published_date, ANY_VALUE(video_length) AS video_length
                FROM \`${PROJECT}.reptranscripts.youtube_videos\` WHERE video_id = @id`,
        params: { id },
      });
      if (!r || r.title == null) { note("respeaker-not-in-bigquery", id); return; }
      const [segRows] = await bigQuery.query({
        query: `SELECT ANY_VALUE(start_sec) AS start, ANY_VALUE(text) AS text FROM \`${PROJECT}.reptranscripts.youtube_transcript_segments\`
                WHERE video_id = @id GROUP BY segment_index ORDER BY segment_index`,
        params: { id },
      });
      const segments = segRows.map((x: any) => ({ start: Number(x.start) || 0, text: String(x.text || ""), duration: 0 }));
      const metadata: any = await fetchYoutubeMetadata(`https://www.youtube.com/watch?v=${id}`, SPEAKER!);
      const text = formatTranscriptAsText({ transcript_data: segments } as any);
      const first = await identifySpeakers(text, metadata.title, metadata.description, SPEAKER!, metadata.channelName);
      const third = await verifyAndCleanSpeakers(text, metadata.title, metadata.description, SPEAKER!, first || "", metadata.channelName);
      let found = third || first || "";
      if (!hasSpeaker(found, SPEAKER!)) found = found ? `${found}, ${SPEAKER}` : SPEAKER!;
      // Never drop a speaker already recorded (e.g. added by verify --repair).
      const merged = [...split(found), ...split(r.speaker_source).filter((s) => !hasSpeaker(found, s))].join(", ");
      const added = split(merged).filter((s) => !hasSpeaker(r.speaker_source, s));
      if (!added.length) { note("respeaker-unchanged", id); console.log(`  [${id}] unchanged: ${r.speaker_source}`); return; }
      console.log(`  [${id}] ${r.speaker_source} → ${merged}${DRY_RUN ? " (dry run)" : ""}`);
      if (DRY_RUN) { note("respeaker-would-update", id); return; }
      await bigQuery.query({
        query: `UPDATE \`${PROJECT}.reptranscripts.youtube_videos\` SET speaker_source = @s WHERE video_id = @id`,
        params: { s: merged, id },
      });
      await uploadToVectorStore({
        videoId: id, title: r.title, channel: r.channel || "", publishedDate: r.published_date || null,
        duration: r.video_length || null, speakerSource: merged, languageCode: "en", segments, onlySpeakers: added,
      });
      note("respeaker-updated", id);
    } catch (e: any) {
      console.error(`  [${id}] respeaker FAILED: ${e.message}`);
      note("respeaker-failed", id);
    }
  });
}

// ── Phase: verify (+ repair) ────────────────────────────────────────────

function hasSpeaker(speakerSource: string | null | undefined, speaker: string): boolean {
  const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return (speakerSource || "").split(",").some((s) => norm(s) === norm(speaker));
}

async function verifyPhase(ids: string[], note: (b: string, id: string) => void, bigQuery: any) {
  console.log(`\n── Verify${REPAIR ? " + repair" : ""}: BigQuery, speaker, chat file, Bunny video ──`);
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { uploadToVectorStore } = await import("../src/components/transcribe/utils/vector-upload");

  const [rows] = await bigQuery.query({
    query: `SELECT v.video_id, ANY_VALUE(v.speaker_source) AS speaker_source, ANY_VALUE(v.video_title) AS title,
              ANY_VALUE(v.channel_name) AS channel, ANY_VALUE(CAST(v.published_date AS STRING)) AS published_date,
              ANY_VALUE(v.video_length) AS video_length, COUNT(DISTINCT v.created_time) AS copies,
              (SELECT COUNT(DISTINCT s.segment_index) FROM \`${PROJECT}.reptranscripts.youtube_transcript_segments\` s WHERE s.video_id = v.video_id) AS segments
            FROM \`${PROJECT}.reptranscripts.youtube_videos\` v WHERE v.video_id IN UNNEST(@ids) GROUP BY v.video_id`,
    params: { ids },
  });
  const byId = new Map(rows.map((r: any) => [r.video_id, r]));

  console.log("  video_id     bq  segs  speaker  chat  bunny");
  for (const id of ids) {
    const r: any = byId.get(id);
    const problems: string[] = [];
    let speakerOk = !!r && hasSpeaker(r.speaker_source, SPEAKER!);
    let chatOk = false;
    let bunny = "-";

    try {
      const res: any = await (openai.vectorStores as any).search(SHARED_VECTOR_STORE_ID, {
        query: SPEAKER,
        max_num_results: 1,
        filters: { type: "and", filters: [
          { type: "eq", key: "video_id", value: id },
          { type: "eq", key: "speaker", value: SPEAKER!.normalize("NFD").replace(/[\u0300-\u036f]/g, "") },
        ] },
      });
      chatOk = (res.data || []).length > 0;
    } catch (e: any) {
      problems.push(`chat check error: ${e.message}`);
    }

    try {
      const key = (process.env.BUNNY_STREAM_API_KEY || "").trim();
      const b = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?search=${id}&itemsPerPage=10`, { headers: { AccessKey: key } });
      const items = ((await b.json()).items || []).filter((v: any) => v.title === id);
      const done = items.find((v: any) => v.status === 4);
      bunny = done ? `${done.height}p` : items.length ? `encoding(${items.map((v: any) => v.status).join("/")})` : "none";
      if (items.length > 1) problems.push(`${items.length} Bunny copies`);
    } catch (e: any) {
      bunny = "error";
    }

    if (REPAIR && r && !speakerOk) {
      const fixed = r.speaker_source ? `${r.speaker_source}, ${SPEAKER}` : SPEAKER!;
      try {
        await bigQuery.query({
          query: `UPDATE \`${PROJECT}.reptranscripts.youtube_videos\` SET speaker_source = @s WHERE video_id = @id`,
          params: { s: fixed, id },
        });
        r.speaker_source = fixed;
        speakerOk = true;
        console.log(`  [${id}] repaired speaker_source → ${fixed}`);
      } catch (e: any) {
        problems.push(`speaker repair deferred (${/streaming buffer/i.test(e.message) ? "rows still in streaming buffer, rerun in ~90 min" : e.message})`);
      }
    }

    if (REPAIR && r && !chatOk && r.segments > 0) {
      const [segRows] = await bigQuery.query({
        query: `SELECT ANY_VALUE(start_sec) AS start, ANY_VALUE(text) AS text FROM \`${PROJECT}.reptranscripts.youtube_transcript_segments\`
                WHERE video_id = @id GROUP BY segment_index ORDER BY segment_index`,
        params: { id },
      });
      const speakerSource = hasSpeaker(r.speaker_source, SPEAKER!) ? r.speaker_source : `${r.speaker_source || ""}, ${SPEAKER}`.replace(/^, /, "");
      try {
        await uploadToVectorStore({
          videoId: id,
          title: r.title || id,
          channel: r.channel || "",
          publishedDate: r.published_date || null,
          duration: r.video_length || null,
          speakerSource,
          languageCode: "en",
          segments: segRows.map((x: any) => ({ start: Number(x.start) || 0, text: String(x.text || ""), duration: 0 })),
          onlySpeakers: [SPEAKER!],
        });
        chatOk = true;
        console.log(`  [${id}] repaired: uploaded ${SPEAKER} chat file`);
      } catch (e: any) {
        problems.push(`chat repair failed: ${e.message}`);
      }
    }

    if (!r) problems.push("not in youtube_videos");
    else {
      if (!r.segments) problems.push("no transcript segments");
      if (!speakerOk) problems.push(`speaker_source lacks ${SPEAKER} (${r.speaker_source})`);
      if (r.copies > 1) problems.push(`${r.copies} duplicate youtube_videos rows`);
    }
    if (!chatOk) problems.push(`no ${SPEAKER} chat file`);
    if (!/^\d+p$/.test(bunny)) problems.push(`Bunny: ${bunny}`);

    const ok = (b: boolean) => (b ? "ok" : "--");
    console.log(`  ${id}  ${ok(!!r)}  ${String(r?.segments ?? 0).padStart(5)}  ${ok(speakerOk).padEnd(7)}  ${ok(chatOk).padEnd(4)}  ${bunny}${problems.length ? "   ⚠ " + problems.join("; ") : ""}`);
    // Bunny still encoding is expected right after a run — amber, not red.
    const red = problems.filter((p) => !/^Bunny: encoding|duplicate youtube_videos/.test(p));
    note(red.length ? "verify-red" : problems.length ? "verify-amber" : "verify-green", id);
    if (/^\d+p$/.test(bunny)) note(`bunny-${bunny}`, id);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
