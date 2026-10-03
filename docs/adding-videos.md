# Adding videos to Snippysaurus in bulk

How to take a list of YouTube videos (for example a youtube-research-server pull
for one speaker) and get each one fully into Snippysaurus: searchable, in the
speaker's chat, and clippable at up to 1080p.

Two scripts:
- `scripts/ingest-batch.ts` does transcripts, chat and the first download attempt.
- `scripts/ytdlp-to-bunny.py` is the yt-dlp fallback, run on Shadow, for anything
  still missing or below 1080p.

## What "fully added" means

A video is done when all four of these are true. The script's verify phase
checks each one.

| Piece | Where it lives | What uses it |
|---|---|---|
| Video row + transcript segments | BigQuery `reptranscripts.youtube_videos` and `youtube_transcript_segments` | Browse, transcript view |
| Speaker name in `speaker_source` | `youtube_videos.speaker_source` (comma-separated) | Browse/search by speaker (`LIKE '%name%'`) |
| Search windows | `reptranscripts.segment_search_windows` (rebuilt from segments) | Quote/text search |
| Chat file for the speaker | OpenAI vector store `vs_69b1015315d88191b6f26c169575bc4c`, one file per speaker per video, attribute `speaker` | The speaker's chat (file_search filtered by speaker) |
| Video file | Bunny Stream library `627230`, asset title = YouTube ID | Clip editor / downloads |

## Prerequisites

- `.env.local` at the repo root with `GOOGLE_APPLICATION_CREDENTIALS_JSON`,
  `YOUTUBE_API_KEY`, `APIFY_TOKEN`, `OPENAI_API_KEY`, `BUNNY_STREAM_API_KEY`.
  Copy it from the main checkout: `cp ~/Desktop/ClaudeCode/FlatCreepyInformation/.env.local .`
- `npm ci --force` (`--force` skips the Linux-only Remotion compositor package on a Mac).
- Bunny prepaid balance topped up. Each hour of video adds about 4.9 GB, which is
  about $0.05/month of Bunny storage.

## 1. Make the ID list

One YouTube ID or URL per line. `#` starts a comment.

```
# Max Tegmark set, 2026-10-01
lQVBqPVnNAE  # 1
t931Rs7QQ9c  # 2
https://www.youtube.com/watch?v=87yoGSBQsCk
```

Leave out re-uploads of old content (channels re-posting a 2021 podcast as new).
The research report marks these as "excluded".

## 2. Dry run

```bash
npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "Max Tegmark" --dry-run
```

Shows how many videos are already in Bunny and how many transcripts are already
in BigQuery. Those are skipped. Nothing is written.

## 3. Run it

Videos and transcripts are independent. Run them as two processes so the
downloads start right away:

```bash
npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "Max Tegmark" --only videos > videos.log 2>&1 &
npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "Max Tegmark" --only transcripts \
  --concurrency 4 --confirmed-speaker > transcripts.log 2>&1 &
```

Or run both in one process, which does videos, then transcripts, then verify:

```bash
npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "Max Tegmark" --confirmed-speaker
```

### What the video phase does

For each ID without a finished or in-progress Bunny asset:

- **If GCS already has the file** (`gs://snippysaurus-clips/videos/{id}.mp4`, left
  by an older research batch) and it has a video stream, Bunny fetches it
  straight from GCS. This step exists because the Cloud Run downloader skips any ID
  whose GCS file exists, even in Bunny-only mode. That bug made 15 of the
  Tegmark videos "succeed" in 2 seconds with nothing uploaded. A GCS file with no
  video stream (one Tegmark file was audio-only) is left for the yt-dlp fallback.
- **Otherwise** it starts one `bunny-downloader` Cloud Run execution. That is the
  same job `/transcribe` uses.

- RapidAPI downloads the video from YouTube on its servers and returns a temporary link.
- The job passes that link to Bunny's fetch-from-URL API. Bunny's servers pull the
  file directly; it never touches the Mac or GCS.
- It asks for 1080p first and falls back to 720p. Nothing above 1080p is requested.
- Bunny encodes 240p–1080p renditions. Long videos take 45–90 min.
- Triggers are spaced 10 s apart (`--trigger-gap-ms`) so RapidAPI isn't hit all at once.

One execution per video means a Cloud Run retry can only ever re-download that
one video. Batch `VIDEO_LIST` mode would retry a whole slice and create
duplicate Bunny assets.

### What the transcript phase does

For each ID not already in `youtube_videos`, it runs the same steps as one
`/transcribe` submit:

1. YouTube Data API metadata, plus a `transcribe_log` row.
2. Transcript: Apify, then the Vercel proxy, then ElevenLabs as a last resort.
   ElevenLabs costs money and only runs when there are no captions.
3. GPT-4o speaker passes 2 and 3.
4. Public Google Doc of the transcript.
5. BigQuery `youtube_videos` + `youtube_transcript_segments`.
6. OpenAI vector store: one file per detected speaker.
7. At the end, `segment_search_windows` is rebuilt once. It is not rebuilt per
   video: concurrent `CREATE OR REPLACE` statements collide.

**Use `--confirmed-speaker` when the list was already checked by the research
judge.** The GPT speaker passes only read the first 20,000 characters of the
transcript. On a long show where the guest appears later (Meet the Press,
Bloomberg's 2.5 h weekend show), they drop the guest. The video then never shows
up under that person in search or chat. The flag keeps the speaker in
`speaker_source` no matter what the passes return, so the chat file is created too.

## 4. Verify (and repair)

```bash
npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "Max Tegmark" --only verify
npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "Max Tegmark" --only verify --repair
```

Prints one line per video:

```
  video_id     bq  segs  speaker  chat  bunny
  lQVBqPVnNAE  ok    150  ok       ok    1080p
  t931Rs7QQ9c  ok   1419  --       --    encoding(3)   ⚠ speaker_source lacks Max Tegmark ...
```

- **green**: everything present, Bunny finished.
- **amber**: only waiting on a Bunny encode, or duplicate BigQuery rows (harmless).
- **red**: something missing. The command exits 1.

`--repair` appends the speaker to `speaker_source` and uploads only the missing
chat file for that speaker. Other speakers' files are not duplicated. BigQuery
refuses `UPDATE` on rows streamed in the last ~90 minutes, so speaker repairs on
brand-new rows are reported as "deferred". Rerun `--repair` later.

Rerun verify about 2 hours after the run to confirm every Bunny encode finished.
For any video still at `none`, rerun `--only videos` (it skips the ones that worked).

## 5. yt-dlp fallback on Shadow

For every ID where Bunny has no finished video, or one below 1080p when YouTube
has 1080p:

```powershell
$env:BUNNY_STREAM_API_KEY = "<key>"
python -X utf8 scripts\ytdlp-to-bunny.py --ids ids.txt --workdir C:\ytdlp-bunny --dry-run
python -X utf8 scripts\ytdlp-to-bunny.py --ids ids.txt --workdir C:\ytdlp-bunny
```

For each candidate it downloads the best ≤1080p mp4 with yt-dlp and checks the
height with ffprobe. It then uploads the file straight to Bunny and waits for the
encode. Once Bunny reports it finished, the script deletes the local file and every
older Bunny asset for that ID (failed, stuck or lower-res). If the encode fails,
the local file is kept. It skips:

- videos already at 1080p,
- videos where YouTube has nothing better than what Bunny has,
- videos with a Bunny asset still processing, younger than `--stale-min` (default 120 min).

For IDs it skips because a finished copy is already good enough, it still deletes the extra
copies (failed, stale or duplicate) and keeps the best finished one, because `/api/bunny-lookup`
takes the first search hit. Copies still encoding are left alone. `--no-prune` turns this off.

Its report is `<workdir>/ytdlp-to-bunny-report.json`. Run it through Relay
(`--needs shadow,windows,ffmpeg,claude`) with the script and ID list attached. Shadow
has a residential IP, so YouTube doesn't block it the way it blocks cloud IPs. Run it
again about an hour later to catch encodes that were still running the first time.

## Gotchas

- **No dedup anywhere else.** `/transcribe` and the CSV "Bulk Import" button
  re-ingest and re-download a video every time. This script checks BigQuery and
  Bunny first, so it is safe to rerun.
- **The CSV "Bulk Import" button never downloads the video.** It only does
  transcripts, one at a time, in a browser tab that has to stay open. Use this
  script instead.
- **Stopping a transcript run mid-video** can leave a video in BigQuery with no
  chat file. The next run skips it as "already in BigQuery". Run
  `--only verify --repair` to fill the gap.
- **RapidAPI rejects some videos** ("too long", livestreams, private), and
  sometimes falls back to 720p when YouTube has 1080p. Step 5 catches both.
- **Resolution follows the source.** If YouTube only has 720p, you get 720p.

## Cost (Max Tegmark set, 76 videos / ~44 h, 2026-10-01)

| Item | Cost |
|---|---|
| Apify transcripts | $0.001 each, ~$0.06 |
| GPT-4o speaker passes | ~$1–3 |
| BigQuery (one search-window rebuild) | ~cents |
| Cloud Run downloader | ~$2–6 |
| RapidAPI downloads | per your RapidAPI plan |
| Bunny storage | ~215 GB, about $2.15/month ongoing |
