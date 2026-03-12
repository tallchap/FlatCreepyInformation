FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install bgutil PO token provider plugin for yt-dlp
# This generates authentic Proof-of-Origin tokens to bypass YouTube bot detection
RUN pip3 install --break-system-packages bgutil-ytdlp-pot-provider

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
