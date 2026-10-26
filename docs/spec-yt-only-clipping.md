# Spec: YouTube-only clipping (no stored video)

Status: draft for engineering, 2026-10-24. Nothing in this spec is built yet.

## Goal

Add a YouTube video to Snippysaurus **without downloading or storing it**, edit it on
a YouTube embed with the site's own editor UI, pick **several ranges** from different
points in the video, and download them joined as one MP4. The video file is fetched
from YouTube only at export time, cut, sent to the user, and deleted.

## Walkthrough example

Everything below uses this video:

| | |
|---|---|
| URL | https://www.youtube.com/watch?v=anAmTGcewX8 |
| Title | Sam Altman, Co-Founder and CEO of OpenAI: Staying Human While Scaling Superintelligence |
| Channel | Stanford Graduate School of Business |
| Length | 48:48 (2,928 s) |
| Published | 2026-10-21 |

Target output: one **2:10 (130 s)** MP4 made of three pieces from different parts of the
talk, for example:

| # | In | Out | Length |
|---|---|---|---|
| 1 | 04:12.0 | 04:57.0 | 45 s |
| 2 | 18:30.5 | 19:20.5 | 50 s |
| 3 | 41:05.0 | 41:40.0 | 35 s |

(Timestamps are placeholders; the editor picks the real ones from the transcript.)

## Can the current editor do this?

**No.** `/edit` holds a single `startSec` / `endSec` pair
(`src/components/edit/clip-editor.tsx:43-44`) and every export route takes one range
(`services/download/server.js:492`, `:1159`). A 2:10 clip stitched from three places
needs a **segment list** in the UI, in the API payload and in the cutter. That is the
main new piece. The max-length rule (`MAX_CLIP_SEC = 11 min`, `clip-editor.tsx:30`)
should apply to the **sum** of the segments.

The YouTube embed path exists (`clip-editor.tsx:350-389`) but is the last fallback and
shows YouTube's full player chrome, which is what made the editor unpleasant before.
The spec fixes that too.

## What stays the same

- Transcript ingest (Apify → BigQuery → search windows → vector store) is unchanged.
  `scripts/ingest-batch.ts --only transcripts` already does this without touching video.
- Bunny-backed videos keep working exactly as they do now. This spec adds a second
  source, it does not remove the first.
- The existing download server on Render stays the place where cutting happens.

---

## Part 0 — Feasibility gates (do these first, 1–2 h)

Each gate is a yes/no with evidence. If a gate fails, stop and report; the rest of the
spec changes shape.

### Gate A: RapidAPI URL supports byte ranges from Render

The on-demand plan only saves time if the cutter can fetch *part* of the file.

1. On the Render download service, call the existing RapidAPI step for `anAmTGcewX8`
   at 720p and get the direct `downloadUrl` (same code as `server.js:509-626`).
2. `curl -sI -r 0-1023 "$URL"` → want `HTTP/2 206` and `Accept-Ranges: bytes`.
3. `ffmpeg -ss 252 -to 297 -i "$URL" -c copy -t 45 out.mp4` → note wall time and bytes
   transferred (`-stats`), compare with downloading the full file.

Pass: 206 + ffmpeg pulls well under the full file size for a 45 s piece.
Fail: every export re-downloads the whole video (still zero storage, just slower;
keep the current curl-full-then-cut code and only add segments).

### Gate B: yt-dlp `--download-sections` works from Render today

The fallback at `server.js:634-639` runs yt-dlp with PO tokens, no proxy. Run it once
by hand for one of the three ranges above and record: success/failure, stderr, time.
History (commits `8931f62`, `38bc992`, `8cc5d15`, `3a667f9`) says this was flaky in
March. It should be treated as fallback only unless Gate B passes cleanly three runs in
a row.

### Gate C: embed player can be made "clean" enough to edit on

Build a throwaway page (`/yt-embed-test`) with the player settings from Part 2.3 and
take screenshots at: loading, playing, hovering, paused, seeking, last 20 s. Confirm:
no control bar, no hover title bar, no "Watch on YouTube" link, no "More videos"
panel on pause. Record whether an ad played (use a monetized video as a second test;
the Stanford GSB video may not be monetized).

Known limits that cannot be fixed and must be accepted up front: ads inside the
embed, the first ~1 s of YouTube branding on load, and YouTube's embed terms (they
prohibit covering the player; low risk for an internal tool, real risk for a public one).

---

## Part 1 — Add the video (no download)

### 1.1 Entry point

Today there is no in-app "add a video" page; bulk adds go through
`scripts/ingest-batch.ts`. Add a small admin page:

`/admin/add-video`: paste one URL or ID → shows title/channel/length (from oEmbed or
the YouTube Data API) → speaker name field (prefilled from the title when obvious) →
**Add** button.

Behind it, `POST /api/admin/add-video` with `{ videoId, speaker, mode: "yt-only" }`.

### 1.2 What "added" means in yt-only mode

| Piece | Done? | Notes |
|---|---|---|
| `youtube_videos` row + transcript segments | yes | existing transcript path |
| `speaker_source` | yes | existing |
| `segment_search_windows` | yes | existing rebuild |
| Chat file in vector store | yes | existing |
| Video file in Bunny | **no** | new column `video_source = 'youtube'` |

Add `video_source` (`'bunny'` \| `'youtube'`) to `youtube_videos`. Bunny rows keep
`'bunny'`. The editor and the exporter branch on this field. `scripts/corpus-integrity`
must treat `video_source='youtube'` rows as complete without a Bunny asset.

### 1.3 Walkthrough

1. Open `/admin/add-video`, paste `https://www.youtube.com/watch?v=anAmTGcewX8`.
2. Page shows "Sam Altman… · Stanford GSB · 48:48". Speaker: `Sam Altman`.
3. Click Add. Status line shows: transcript fetched (Apify) → 2,9xx segments stored →
   search windows rebuilt → chat file uploaded → **Ready to clip**. Under a minute.
4. The video appears in Browse and Search; `/edit?v=anAmTGcewX8` opens the editor.

Acceptance: the four `ok` columns in the ingest verify phase pass for this ID with no
Bunny asset, and Bunny's library count did not change.

---

## Part 2 — Edit on the YouTube embed

### 2.1 Source selection

`/edit` loads the video row. If `video_source === 'youtube'` (or Bunny lookup fails),
the player mounts the YouTube iframe directly instead of trying Bunny → GCS → YouTube
in sequence. No 404s, no spinner while the Bunny lookup times out.

### 2.2 Player wrapper

Wrap the iframe in a component `YouTubeCleanPlayer` with this interface, which the
editor already expects (`clip-editor.tsx:340-348` builds the same shape for Bunny):

```
seekTo(sec), getCurrentTime(), getDuration(), playVideo(), pauseVideo(),
getPlayerState(), setPlaybackRate(r), destroy()
```

Plus `onTime(cb)` polled at 100 ms so the playhead and transcript highlighting move
smoothly (the iframe API has no timeupdate event).

### 2.3 Hiding YouTube's chrome (what "clean" means)

1. `playerVars`: `controls: 0, rel: 0, iv_load_policy: 3, disablekb: 1, fs: 0,
   playsinline: 1, origin: <site origin>`. Drop `modestbranding` (no effect since 2023).
2. **Shield**: a transparent `div` over the iframe with `pointer-events: auto`. It
   receives all mouse events, so YouTube never sees hover or clicks. Clicking the shield
   toggles play/pause through the API.
3. **Crop**: iframe height = 16:9 height + 2 × 60 px, container `overflow: hidden`,
   iframe translated up by 60 px. YouTube letterboxes the video and draws its title
   bar and pause panel in those bands. Tune 60 px against Gate C screenshots.
4. Pause behaviour: when the user pauses, YouTube may show a "More videos" panel.
   With the crop this should be out of view; if Gate C says it is not, pause by
   `seekTo(current)` + `pauseVideo()` and overlay a freeze frame from the storyboard
   (2.4) for the first 300 ms.
5. End screens: the editor never plays into the last 20 s automatically; the preview
   loop stops at the clip's out point.

### 2.4 Timeline filmstrip without video

Bunny videos get thumbnails from Bunny. For yt-only, use YouTube's storyboard sprites
(`storyboard` spec in the player response: 100 × 56 tiles at 5–10 s steps). Fetch once
server-side (`/api/video-meta?storyboard=1`) and cache the sprite URLs. If the
storyboard spec is not available, fall back to the 4 static thumbnails (`hq1/2/3`).

### 2.5 Multi-segment selection (new)

State: `segments: { in: number, out: number }[]`, ordered by the user, not by time.

UI:
- The existing timeline shows all segments as coloured bands; the active one has drag
  handles. Click a band to make it active.
- **"+ Add segment"** creates a new 10 s band at the playhead and makes it active.
- Transcript click moves the active segment's nearer handle (keep existing behaviour).
- Clip Finder result → new segment.
- Segment list panel on the right: `#`, in, out, length, ▲▼ reorder, ✕ remove, with
  the **total** shown at the bottom and turning red past 11:00.
- Preview: "Play all" plays segment 1, seeks to segment 2's in point, and so on.
  Seeks on the YouTube embed take 300–800 ms; show a short fade so it does not look
  broken.
- Deep link: `?v=ID&seg=252-297,1110.5-1160.5,2465-2500` (seconds, comma-separated).
  Keep `?start=&end=` working as a one-segment alias.

### 2.6 Walkthrough

1. Open `/edit?v=anAmTGcewX8`. Player mounts the clean embed; filmstrip loads from
   storyboard sprites; transcript appears on the right.
2. Search the transcript for the first quote, click the line → segment 1 at 04:12.
   Drag the out handle to 04:57. Panel shows `1 · 04:12.0 → 04:57.0 · 45.0 s`.
3. Click **+ Add segment**, scrub to 18:30, click the transcript line → segment 2,
   set out at 19:20.5.
4. Same for segment 3 at 41:05 → 41:40.
5. Total reads **2:10.0**. Press "Play all" and watch the three pieces in order.
6. Choose 720p or 1080p (availability comes from `getAvailableQualityLevels()` as
   today, `clip-editor.tsx:366-369`).

Acceptance: no YouTube control bar, title or "Watch on YouTube" visible at any step in
a recorded walkthrough; segment times shown in the panel match the API payload byte
for byte; total length enforces 11:00.

---

## Part 3 — Export: fetch on demand, cut, join, send, delete

### 3.1 API

`POST /api/clip` (and the Render `/clip`) accept:

```json
{
  "videoId": "anAmTGcewX8",
  "quality": "720p",
  "segments": [
    { "in": 252.0,  "out": 297.0  },
    { "in": 1110.5, "out": 1160.5 },
    { "in": 2465.0, "out": 2500.0 }
  ]
}
```

`startSec`/`endSec` remain accepted as a one-segment shorthand so nothing else breaks.
Validation: 1–20 segments, each ≥ 1 s, total ≤ 660 s, all within `lengthSeconds`.

### 3.2 Source resolution order (server)

1. `video_source === 'bunny'` → current Bunny path, unchanged.
2. Otherwise **RapidAPI direct URL** (existing code, `server.js:509`). Cache the URL
   per `videoId+quality` as today.
3. Fallback: `yt-dlp --download-sections` per segment (existing `server.js:634`),
   one call per segment, with `--force-keyframes-at-cuts`.
4. Last resort: full yt-dlp download, then cut. Report which path was used in the job
   status (`job.source = "rapidapi-range" | "rapidapi-full" | "ytdlp-sections" | "ytdlp-full"`).

### 3.3 Cutting and joining

For each segment, with the RapidAPI URL as input:

```
ffmpeg -ss {in} -to {out} -i "$URL" \
  -map 0:v:0 -map 0:a:0 -c:v libx264 -preset fast -b:v 2500k -g 30 -bf 0 \
  -c:a aac -b:a 128k -af "afade=t=in:d=0.03,afade=t=out:st={len-0.03}:d=0.03" \
  -movflags +faststart seg-{n}.mp4
```

Re-encode (not stream copy) so every piece has identical codec parameters and frame-
accurate cuts; the current single-range code already re-encodes for the same reason
(`server.js:1046-1056`). Then:

```
ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart clip-{jobId}.mp4
```

If Gate A passed, ffmpeg reads only the byte ranges it needs. If it failed, keep
"curl full file once, then cut all segments from the local file".

Delete the segment files and any raw download the moment the concat finishes; the
final clip keeps the current 30 min TTL in `/tmp` (`server.js:481-490`), then is
deleted. Nothing is written to Bunny or GCS.

### 3.4 Progress

`job.stage` gains per-segment detail: `fetching 2/3`, `cutting 2/3`, `joining`.
The client's existing 3 s poll and blob download (`src/lib/download-context.tsx`)
need no change beyond showing the stage text.

### 3.5 Walkthrough

1. Click **Export Snippet** with the three segments at 720p.
2. Status: `resolving source` (RapidAPI, ~5–20 s on first request for this video) →
   `fetching 1/3` → `cutting 1/3` … → `joining` → `ready`.
3. The browser downloads `Sam-Altman-…-clip.mp4`. Expected: 130.0 s ± 0.1 s, 720p,
   H.264 + AAC, ~40 MB at 2.5 Mbps, plays in QuickTime and Chrome with three clean
   cuts and no audio pops at the joins.
4. On Render, `/tmp` contains only `clip-{jobId}.mp4`; after 30 min, nothing.
5. Bunny and GCS unchanged.

Acceptance: `ffprobe` duration 129.9–130.1 s; three cuts land within one frame of the
requested times (check by extracting frames at the join points and comparing with the
embed at the same timestamps); total bytes pulled from the RapidAPI URL < 25 % of the
full file when Gate A passed.

---

## Part 4 — Verifier

Add `scripts/verify-yt-only.mjs` that runs end to end against production with the
Altman video and the three segments above, and prints a checklist, red on any failure,
exit 1:

- video row exists, `video_source='youtube'`, no Bunny asset for the ID
- transcript segment count > 2,000 and search windows present
- `/edit?v=anAmTGcewX8&seg=…` returns 200 and the page contains the segment panel
  with total `2:10.0` (headless Chrome)
- export job completes, `job.source` recorded, duration 130 s ± 0.1
- cut accuracy: three join frames within 1 frame
- Render `/tmp` has no `seg-*` or `raw-*` files for the job afterwards
- Bunny library count unchanged before vs after

Also extend `scripts/corpus-integrity` so yt-only rows are not flagged as "approved
video without a Bunny asset".

---

## Out of scope

- Snippy (`/snippy`, Remotion overlays and karaoke captions). It needs a real video
  file in the browser; a yt-only Snippy would first fetch a short window around the
  pick to S3 and edit that. Separate spec.
- Migrating existing Bunny videos to yt-only. Once this works for a few weeks, decide
  per channel whether to stop storing new videos.
- Private, members-only or age-gated videos: RapidAPI and yt-dlp both fail without
  cookies. The add page should refuse them with a clear message.

## Risks, stated plainly

- **Ads in the embed** will interrupt editing on monetized videos. No fix.
- **YouTube bot checks** can break RapidAPI or yt-dlp on any given day. The job
  status must say which source was used and why the others failed, so a failed export
  is diagnosable in one look at `/admin/log`.
- **Deleted or private videos** stop being clippable immediately. With Bunny they
  did not. If that matters for a speaker, keep storing that speaker's videos.
- **Embed terms**: hiding player chrome is against YouTube's API terms. Acceptable for
  an internal editor; revisit before making it public.

## Effort

Human team ~2 weeks (segments UI, clean player, server cut/join, verifier, QA).
AI-assisted ~3–4 hours plus the Part 0 gates, which are the real unknown.
