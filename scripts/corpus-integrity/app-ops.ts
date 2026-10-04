#!/usr/bin/env npx tsx
/**
 * The app's own write paths, driven by integrity.py so data fixes produce
 * exactly what an ingest would (same transcript fetchers, same BigQuery
 * transaction, same chat-file format and attributes).
 *
 *   fetch   --ids f --out dir     Fetch a fresh transcript per ID (Apify → proxy
 *                                 → ElevenLabs) into dir/<id>.json. Writes nothing else.
 *   replace --ids f --from dir    Store dir/<id>.json as the transcript (one
 *                                 transaction, metadata kept), then re-upload chat files.
 *   chat    --jobs f.json         [{videoId, onlySpeakers?, language?}] → upload chat files from
 *                                 BigQuery; a full upload replaces the video's old files.
 *
 * Prints one JSON line per ID: {"id", "ok", ...}. Exits 1 if any ID failed.
 */
import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";

config({ path: path.resolve(__dirname, "../../.env.local") });

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const lines = (f: string) => fs.readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

async function videoForChat(bigQuery: any, id: string) {
  const [[v]] = await bigQuery.query({
    query: `SELECT video_id, video_title, channel_name, CAST(published_date AS STRING) published_date, video_length,
              speaker_source, youtube_link, CAST(created_time AS STRING) created_time
            FROM \`youtubetranscripts-429803.reptranscripts.youtube_videos\` WHERE video_id=@id`,
    params: { id },
  });
  if (!v) throw new Error("not in youtube_videos");
  const [segs] = await bigQuery.query({
    query: `SELECT start_sec, text FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcript_segments\`
            WHERE video_id=@id
            QUALIFY ROW_NUMBER() OVER (PARTITION BY segment_index, line_index ORDER BY created_at)=1
            ORDER BY segment_index, line_index`,
    params: { id },
  });
  return { v, segs };
}

async function main() {
  const mode = process.argv[2];
  const { bigQuery } = await import("../../src/lib/bigquery");
  const { uploadToVectorStore } = await import("../../src/components/transcribe/utils/vector-upload");
  let failed = 0;
  const report = (o: Record<string, unknown>) => {
    if (!o.ok) failed++;
    console.log(JSON.stringify(o));
  };

  const chat = async (videoId: string, onlySpeakers?: string[], languageCode = "en") => {
    const { v, segs } = await videoForChat(bigQuery, videoId);
    await uploadToVectorStore({
      videoId,
      title: v.video_title || "",
      channel: v.channel_name || "",
      publishedDate: v.published_date || null,
      duration: v.video_length || null,
      speakerSource: v.speaker_source || "",
      languageCode,
      segments: segs.map((s: any) => ({ text: s.text, start: Number(s.start_sec) || 0, duration: 0 })),
      onlySpeakers,
    });
  };

  if (mode === "fetch") {
    const { fetchYoutubeTranscript } = await import("../../src/components/transcribe/utils/controller");
    const out = arg("out")!;
    fs.mkdirSync(out, { recursive: true });
    for (const id of lines(arg("ids")!)) {
      try {
        const t: any = await fetchYoutubeTranscript(`https://www.youtube.com/watch?v=${id}`);
        fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify(t));
        const data = t.transcript_data || [];
        const last = data.length ? Number(data[data.length - 1].start) + Number(data[data.length - 1].duration || 0) : 0;
        report({ id, ok: true, source: t._source || null, segments: data.length, last_time: last });
      } catch (e: any) {
        report({ id, ok: false, error: e.message });
      }
    }
  } else if (mode === "replace") {
    const { buildSegmentRows, replaceTranscript } = await import("../../src/lib/transcript-store");
    const from = arg("from")!;
    for (const id of lines(arg("ids")!)) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(from, `${id}.json`), "utf8"));
        const [[v]] = await bigQuery.query({
          query: `SELECT video_title, channel_name, CAST(published_date AS STRING) published_date, youtube_link, video_length, speaker_source
                  FROM \`youtubetranscripts-429803.reptranscripts.youtube_videos\` WHERE video_id=@id`,
          params: { id },
        });
        if (!v) throw new Error("not in youtube_videos");
        const rows = buildSegmentRows(id, t.transcript_data || []);
        await replaceTranscript(bigQuery, { video_id: id, ...v, created_time: new Date().toISOString() }, rows);
        await chat(id, undefined, t.language_code || "en");
        report({ id, ok: true, segments: rows.length });
      } catch (e: any) {
        report({ id, ok: false, error: e.message });
      }
    }
  } else if (mode === "chat") {
    const jobs: { videoId: string; onlySpeakers?: string[]; language?: string }[] = JSON.parse(fs.readFileSync(arg("jobs")!, "utf8"));
    for (const j of jobs) {
      try {
        await chat(j.videoId, j.onlySpeakers, j.language || "en");
        report({ id: j.videoId, ok: true, onlySpeakers: j.onlySpeakers || null });
      } catch (e: any) {
        report({ id: j.videoId, ok: false, error: e.message });
      }
    }
  } else {
    console.error("usage: app-ops.ts fetch|replace|chat …");
    process.exit(2);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
