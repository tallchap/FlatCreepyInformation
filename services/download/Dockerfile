FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl git \
      build-essential pkg-config libcairo2-dev libjpeg-dev \
      libpango1.0-dev libgif-dev librsvg2-dev && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    pip3 install --break-system-packages bgutil-ytdlp-pot-provider==1.3.1 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Build bgutil PO token HTTP server
RUN git clone --single-branch --branch 1.3.1 \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil && \
    cd /opt/bgutil/server && npm ci && npx tsc

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

EXPOSE 3001
CMD ["bash", "start.sh"]
