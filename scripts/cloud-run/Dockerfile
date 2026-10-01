# Image for the gcs-downloader and bunny-downloader Cloud Run jobs.
# Reconstructed 2026-10-01 from the history of gcr.io/youtubetranscripts-429803/gcs-downloader:b68d37d
# (the file was never committed). Build + deploy steps are in CONTEXT.md.
FROM node:20-slim
# ffmpeg provides ffprobe, used to reject audio-only GCS copies before Bunny sees them.
RUN apt-get update && apt-get install -y curl ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/* && ffprobe -version | head -1
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY download-to-gcs.mjs .
CMD ["node", "download-to-gcs.mjs"]
