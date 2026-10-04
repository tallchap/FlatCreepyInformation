#!/usr/bin/env npx tsx
/**
 * Live check of src/lib/transcript-store.ts against throwaway copies of the
 * production tables (dataset snippy_scratch_<ts>, dropped at the end).
 *
 *   1. Reproduces the old bug: a streamed row cannot be deleted for ~30 min.
 *   2. Two back-to-back ingests of one video leave exactly one copy.
 *   3. Columns owned by other jobs (vitrupo_score) survive a re-ingest.
 *   4. A pre-existing duplicate row makes the write fail and roll back whole.
 *
 * Usage: npx tsx scripts/corpus-integrity/live-transcript-store-test.ts
 * Exits 1 on any failed check.
 */
import * as path from "path";
import { config } from "dotenv";

config({ path: path.resolve(__dirname, "../../.env.local") });

async function main() {
  const { bigQuery } = await import("../../src/lib/bigquery");
  const { buildSegmentRows, replaceTranscript } = await import("../../src/lib/transcript-store");
  const PROJECT = "youtubetranscripts-429803";
  const ds = `snippy_scratch_${Date.now()}`;
  const tables = { videos: `${PROJECT}.${ds}.youtube_videos`, segments: `${PROJECT}.${ds}.youtube_transcript_segments` };
  const results: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push([name, ok, detail]);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const count = async (t: string, id: string) =>
    Number((await bigQuery.query({ query: `SELECT COUNT(*) n FROM \`${t}\` WHERE video_id=@id`, params: { id } }))[0][0].n);

  await bigQuery.query({ query: `CREATE SCHEMA \`${PROJECT}.${ds}\` OPTIONS(location='US', default_table_expiration_days=1)` });
  try {
    for (const t of ["youtube_videos", "youtube_transcript_segments"]) {
      await bigQuery.query({ query: `CREATE TABLE \`${PROJECT}.${ds}.${t}\` LIKE \`${PROJECT}.reptranscripts.${t}\`` });
    }

    // 1. The root cause, reproduced with the old write path.
    const old = "oldpath0001";
    await bigQuery.dataset(ds).table("youtube_videos").insert({ video_id: old, created_time: new Date().toISOString() });
    let blocked = "";
    try {
      await bigQuery.query({ query: `DELETE FROM \`${tables.videos}\` WHERE video_id=@id`, params: { id: old } });
    } catch (e: any) {
      blocked = e.message;
    }
    check("old path: DELETE of a just-streamed row is refused", /streaming buffer/i.test(blocked), blocked.slice(0, 90));

    // 2. Back-to-back ingests (the RJyPVLMyyuA case: 15 min apart; here seconds).
    const id = "newpath0001";
    const video = (speakers: string) => ({
      video_id: id, video_title: "Live test", channel_name: "Scratch", published_date: "2026-10-04",
      youtube_link: `https://youtu.be/${id}`, video_length: "1:00", speaker_source: speakers,
      created_time: new Date().toISOString(),
    });
    const segs = buildSegmentRows(id, [{ start: 0, text: "a" }, { start: 1, text: "b" }, { start: 2, text: "c" }]);
    await replaceTranscript(bigQuery, video("Alice"), segs, tables);
    await replaceTranscript(bigQuery, video("Alice, Bob"), segs, tables);
    check("two immediate ingests leave one video row", (await count(tables.videos, id)) === 1);
    check("two immediate ingests leave one copy of the transcript", (await count(tables.segments, id)) === 3);
    const [[row]] = await bigQuery.query({ query: `SELECT speaker_source FROM \`${tables.videos}\` WHERE video_id=@id`, params: { id } });
    check("re-ingest updates the metadata", row.speaker_source === "Alice, Bob", row.speaker_source);

    // 3. A shorter re-transcription fully replaces the old segments.
    await bigQuery.query({ query: `UPDATE \`${tables.videos}\` SET vitrupo_score=7 WHERE video_id=@id`, params: { id } });
    await replaceTranscript(bigQuery, video("Alice, Bob"), segs.slice(0, 2), tables);
    check("re-transcription replaces segments exactly", (await count(tables.segments, id)) === 2);
    const [[kept]] = await bigQuery.query({ query: `SELECT vitrupo_score FROM \`${tables.videos}\` WHERE video_id=@id`, params: { id } });
    check("columns owned by other jobs survive", kept.vitrupo_score === 7, String(kept.vitrupo_score));

    // 4. Corrupt state fails closed: a duplicate row aborts the whole write.
    await bigQuery.query({ query: `INSERT INTO \`${tables.videos}\` (video_id) VALUES (@id)`, params: { id } });
    let failed = "";
    try {
      await replaceTranscript(bigQuery, video("Mallory"), segs, tables);
    } catch (e: any) {
      failed = e.message;
    }
    check("duplicate row makes the write throw", /exactly one youtube_videos row/.test(failed), failed.slice(0, 80));
    check("…and rolls back the segment replace", (await count(tables.segments, id)) === 2);

    // 5. Empty transcript binds and clears segments.
    const empty = "newpath0002";
    await replaceTranscript(bigQuery, { ...video("Alice"), video_id: empty, video_title: null, published_date: null }, [], tables);
    check("empty transcript with null fields binds", (await count(tables.videos, empty)) === 1 && (await count(tables.segments, empty)) === 0);
  } finally {
    await bigQuery.query({ query: `DROP SCHEMA \`${PROJECT}.${ds}\` CASCADE` });
    console.log(`dropped ${ds}`);
  }
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
