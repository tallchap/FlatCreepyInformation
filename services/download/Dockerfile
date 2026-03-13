FROM node:20-slim

# System deps
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl git unzip \
    build-essential pkg-config && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Deno (mandatory for yt-dlp YouTube JS challenges since Nov 2025)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# yt-dlp (latest)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# bgutil PO token provider (yt-dlp plugin)
RUN pip3 install --break-system-packages bgutil-ytdlp-pot-provider

# bgutil PO token HTTP server
RUN git clone --depth 1 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil && \
    cd /opt/bgutil/server && npm ci && npx tsc

# wgcf (Cloudflare WARP config generator)
RUN curl -L https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_linux_amd64 \
    -o /usr/local/bin/wgcf && chmod a+rx /usr/local/bin/wgcf

# wireproxy (userspace WireGuard -> SOCKS5, no NET_ADMIN needed)
RUN curl -L https://github.com/pufferffish/wireproxy/releases/latest/download/wireproxy_linux_amd64.tar.gz \
    | tar xz -C /usr/local/bin wireproxy && chmod a+rx /usr/local/bin/wireproxy

# Generate WARP account at build time
RUN cd /tmp && wgcf register --accept-tos && wgcf generate && \
    mv wgcf-profile.conf /etc/wireproxy.conf

# Append wireproxy SOCKS5 config
RUN printf '\n[Socks5]\nBindAddress = 127.0.0.1:1080\n' >> /etc/wireproxy.conf

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

EXPOSE 3001
CMD ["bash", "start.sh"]
