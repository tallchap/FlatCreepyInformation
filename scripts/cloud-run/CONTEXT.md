# GCS Video Download — Cloud Run Pipeline

## Infrastructure
- **Jobs** (same image, different env):
  - `gcs-downloader` — RapidAPI → GCS upload → Bunny fetch. Used by `/api/trigger-download` (research pipeline).
  - `bunny-downloader` — RapidAPI → Bunny fetch direct, no GCS. `MODE=bunny-only`. Used by `/api/trigger-bunny` (from `/transcribe`).
- **Image**: `gcr.io/youtubetranscripts-429803/gcs-downloader` (shared)
- **GCS bucket**: `snippysaurus-clips`
- **BigQuery source**: `youtubetranscripts-429803.reptranscripts.youtube_videos`

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
