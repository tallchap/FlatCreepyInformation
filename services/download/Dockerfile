FROM node:20-slim

# System deps
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl git unzip \
    build-essential pkg-config && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Deno (mandatory for yt-dlp YouTube JS challenges since Nov 2025)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# yt-dlp + bgutil PO token provider (same Python env so plugin is discovered)
RUN pip3 install --break-system-packages "yt-dlp>=2026.03.13" bgutil-ytdlp-pot-provider

# bgutil PO token HTTP server
RUN git clone --depth 1 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil && \
    cd /opt/bgutil/server && npm ci && npx tsc

# wgcf (Cloudflare WARP config generator) — asset name is versioned
RUN WGCF_URL=$(curl -sL -o /dev/null -w '%{url_effective}' \
      "https://github.com/ViRb3/wgcf/releases/latest") && \
    WGCF_VER=$(basename "$WGCF_URL") && \
    curl -fL "https://github.com/ViRb3/wgcf/releases/download/${WGCF_VER}/wgcf_${WGCF_VER#v}_linux_amd64" \
      -o /usr/local/bin/wgcf && chmod a+rx /usr/local/bin/wgcf

# wireproxy (userspace WireGuard -> SOCKS5, no NET_ADMIN needed)
RUN curl -fL https://github.com/pufferffish/wireproxy/releases/latest/download/wireproxy_linux_amd64.tar.gz \
    | tar xz -C /usr/local/bin wireproxy && chmod a+rx /usr/local/bin/wireproxy

# Verify all binaries are real executables (not 404 HTML pages)
RUN wgcf --help > /dev/null 2>&1 && echo "wgcf OK" && \
    wireproxy --help > /dev/null 2>&1 && echo "wireproxy OK" && \
    yt-dlp --version && echo "yt-dlp OK"

# WARP account generation happens at runtime (start.sh) since
# build environment may have different network restrictions

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

EXPOSE 3001
CMD ["bash", "start.sh"]
