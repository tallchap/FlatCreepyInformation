# GCS Video Download — Cloud Run Pipeline

## Infrastructure
- **Jobs** (same image, different env):
  - `gcs-downloader` — RapidAPI → GCS upload → Bunny fetch. Used by `/api/trigger-download` (research pipeline).
  - `bunny-downloader` — RapidAPI → Bunny fetch direct, no GCS. `MODE=bunny-only`. Used by `/api/trigger-bunny` (from `/transcribe`).
- **Image**: `gcr.io/youtubetranscripts-429803/gcs-downloader` (shared)
- **GCS bucket**: `snippysaurus-clips`
- **BigQuery source**: `youtubetranscripts-429803.reptranscripts.youtube_videos`

## Build + deploy the image

`Dockerfile` here was reconstructed on 2026-10-01 from the `b68d37d` image history (it had never been committed).
Tag images with the git commit, then point the job at the new tag.

```bash
export CLOUDSDK_AUTH_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
SHA=$(git rev-parse --short HEAD)
gcloud builds submit scripts/cloud-run --project youtubetranscripts-429803 \
  --tag gcr.io/youtubetranscripts-429803/gcs-downloader:$SHA
gcloud run jobs update bunny-downloader --region us-central1 --project youtubetranscripts-429803 \
  --image gcr.io/youtubetranscripts-429803/gcs-downloader:$SHA
```

## Bunny-only mode and existing GCS copies
When `videos/{id}.mp4` already exists in GCS, bunny-only mode hands that copy to Bunny. If Bunny can't make a
video from it (an audio-only or broken copy, or a failed fetch), the asset is deleted and the RapidAPI path runs.
Before 2026-10-01 it skipped these videos as "already in GCS", so they never reached Bunny.

## Create `bunny-downloader` (one-time)
```bash
gcloud run jobs create bunny-downloader --region us-central1 \
  --image gcr.io/youtubetranscripts-429803/gcs-downloader \
  --task-timeout 4h --max-retries 3 --parallelism 1 --tasks 1 \
  --cpu 2 --memory 4Gi \
  --set-env-vars MODE=bunny-only,BATCH_SIZE=1,MAX_CONCURRENT=1
# Then set the same secret env vars as gcs-downloader:
#   RAPIDAPI_KEY, BUNNY_STREAM_API_KEY, GOOGLE_APPLICATION_CREDENTIALS_JSON
```
Vercel `/api/trigger-bunny` invokes this job via the Cloud Run Jobs v2 API with a per-invocation `VIDEO_ID` override.

## Current settings (2026-03-25)
- 10 tasks, 10 parallelism
- 2 vCPU / 4Gi memory per container
- `BATCH_SIZE=1000`, `MAX_CONCURRENT=2`
- Task timeout: 4h, max retries: 3

## Run history
| Offset | Date | Result |
|--------|------|--------|
| 1970 | 2026-03-25 | 7/10 tasks OK, 3 OOM-killed. ~131 downloads, ~844 skipped, ~21 failed |
| 2970 | 2026-03-25 | Running (execution `gcs-downloader-h6mp6`) |

## Dashboard
`dashboard.html` in this directory. Static HTML, polls GCS status files every 3s.
Status files: `gs://snippysaurus-clips/download-status/task-{0..N}.json`

## Common commands

```bash
# Check status
gcloud run jobs executions list --job gcs-downloader --region us-central1

# Update offset and run next batch
gcloud run jobs update gcs-downloader --region us-central1 \
  --set-env-vars BATCH_OFFSET=<next>,BATCH_SIZE=1000,CR_CPU=2,CR_MEMORY=4Gi,MAX_CONCURRENT=2
gcloud run jobs execute gcs-downloader --region us-central1

# Kill a run
gcloud run jobs executions cancel <execution-id> --region us-central1 --quiet

# Clean stale status files (when changing container count)
gsutil -m rm gs://snippysaurus-clips/download-status/task-{10..19}.json
```

## Known issues
- 3/10 tasks OOM-killed at 4Gi on the 1970 run. Consider 8Gi if it recurs.

## Files
- `download-to-gcs.mjs` — Main downloader (BigQuery query → RapidAPI download → GCS upload)
- `download-apify.mjs` — Alternative Apify-based downloader
- `dashboard.html` — Real-time monitoring dashboard
- `Dockerfile` — Node.js 20 slim image
