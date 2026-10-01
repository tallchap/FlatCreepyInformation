# Image for the gcs-downloader and bunny-downloader Cloud Run jobs.
# Reconstructed 2026-10-01 from the history of gcr.io/youtubetranscripts-429803/gcs-downloader:b68d37d
# (the file was never committed). Build + deploy steps are in CONTEXT.md.
FROM node:20-slim
RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY download-to-gcs.mjs .
CMD ["node", "download-to-gcs.mjs"]
