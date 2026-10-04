# Corpus integrity

One verifier for the Snippy corpus (BigQuery transcripts, the chat's OpenAI
vector store, Bunny, YouTube) and gated fixes for everything it checks.

```sh
cd scripts/corpus-integrity
PY=~/Desktop/ClaudeCode/google-ads-env-new/bin/python   # google-cloud-bigquery + requests
$PY integrity.py snapshot          # ~3 min: BigQuery, chat files, Bunny, YouTube durations
$PY integrity.py scan-duplicates   # ~1 min: transcript shingles → re-upload candidates
$PY integrity.py check             # checklist; exits 1 on any failure
python3 -m unittest test_plan      # decision logic
node --test ../../src/lib/transcript-store.test.mjs
npx tsx live-transcript-store-test.ts   # transaction checks on throwaway tables
```

`INTEGRITY_YOUTUBE_API_KEY` picks the YouTube key (one `videos.list` call per 50
videos, no `search.list`); credentials otherwise come from `.env.local` and
`GOOGLE_APPLICATION_CREDENTIALS`. Outputs go to `.context/corpus-integrity/`.

## What `check` verifies

| Check | Why it matters |
|---|---|
| one `youtube_videos` row per video; every video has a transcript | counts and lookups |
| transcripts stored once | doubled lines garble search windows and timestamps |
| one search window per caption line; none for deleted videos | site search |
| chat index holds exactly the BigQuery videos, every file tagged and indexed | chat reach |
| no chat file for a speaker no longer on the video; every listed speaker has one; one per speaker | the speaker filter is an exact match; leftovers crowd "All speakers" results |
| stored `video_length` and chat `duration_sec` match YouTube | 687 rows from the March 2026 import stored `MM:SS` as `MM:SS:00` |
| transcripts reach 80% of the real length, or are waived | waivers record what was tried |
| no re-uploads of one recording | the chat cites the wrong copy; "Snip It" may miss the Bunny file |

Info only: videos gone from YouTube, Bunny videos with no transcript.

## Fixes

`integrity.py fix <name>` prints the plan; `--apply` executes it. Each apply first
copies every row it touches into permanent `snippy_history.integrity_<date>_<fix>_*`
tables (chat files: id + full attributes, so they can be re-attached) and writes a
receipt under `.context/corpus-integrity/receipts/`. Take a fresh `snapshot` before
each fix; destructive ones change what the others see.

| Fix | Does |
|---|---|
| `duplicates` | per re-upload group keeps one copy (owns clips/exports › has the Bunny file › still on YouTube › published first › longer transcript), merges the speakers into it, deletes the others from all 19 video-keyed tables, the chat index, Bunny and `gs://snippysaurus-clips/videos/`. Two copies that both own clips are left for a human. |
| `segments` | keeps one copy of each caption line, then rebuilds those videos' search windows |
| `transcripts` | re-fetches captions, then transcribes the audio (`scripts/scribe-transcripts.py`) if captions are short; replaces only on a real gain, otherwise records a waiver with its evidence in `waivers.json` (committed). A failed fetch is reported, never waived. |
| `lengths` | writes the real length in the app's `formatDuration` shape and fixes chat `duration_sec` |
| `speakers` | uploads missing speaker files, then detaches leftovers and surplus copies |
| `windows` | rebuilds wrong search windows, drops windows of deleted videos |
| `bunny-orphans --ids <file>` | deletes Bunny videos (and any `gs://…/videos/<id>.mp4`) from an explicit approved list of titles. Refuses the whole run if any listed video still has a transcript. Files can't be archived, so each one's full Bunny metadata goes to `integrity_<date>_bunny_deleted` first. |

`app-ops.ts` runs the app's own code for anything that writes transcripts or chat
files, so a fix produces exactly what an ingest would.

## Root causes fixed in the app (2026-10-04)

- `addToBigQuery` streamed rows in after a `DELETE`. BigQuery refuses DML on rows in
  the streaming buffer (~30 min), so a re-ingest inside that window kept the old
  transcript and added a second one. `src/lib/transcript-store.ts` now writes the
  video row and all segments in one transaction that asserts exact counts.
- `rebuildSearchWindows` builds from one copy of each caption line.
- `uploadToVectorStore` replaces a video's earlier chat files (speakers dropped from
  `speaker_source` included) instead of adding alongside them.

## First run (2026-10-04)

4,907 → 4,745 videos. Archives: `snippy_history.integrity_20261004_*`.

- `duplicates`: 149 recordings had 2–4 uploads; 162 copies deleted (DB, chat, 20 Bunny
  videos, GCS). Four merged speaker lists needed correcting afterwards (name variants and a
  re-poster); `merged_speakers` now treats first+last-name matches as one person.
- `segments`: 26 transcripts stored 2–7 times reduced to one copy.
- `transcripts`: 2 replaced (Aschenbrenner 26% → 100%, Kleinberg 50% → 100%). 8 waived:
  Scribe on the full audio stops where the captions do (7), or the audio is Dutch (1).
- `lengths`: 655 rows from the March 2026 import; 1,098 chat `duration_sec` values.
- `speakers`: 42 missing speaker files added, 283 leftovers detached.
- `bunny-orphans`: 117 Bunny videos with no transcript deleted (376 GB): 42 left over from the
  Sept 30 cull, 4 test uploads, 61 non-English talks and 10 untraced English uploads from the
  Oct 2 batch. 7 English-audio videos without captions were kept for transcription.
- The app's ElevenLabs fallback (`FFMPEG_TRANSCRIBE_URL`, whisper-transcriber) returned
  `401 payment_required` all run: its ElevenLabs subscription has a failed payment. The
  audio pass therefore uses `scripts/scribe-transcripts.py` with `ELEVENLABS_API_KEY_PRO`.
