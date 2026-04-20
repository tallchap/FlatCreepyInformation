import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "esbuild",
    "ffmpeg-static",
  ],
  outputFileTracingIncludes: {
    "/api/snippy-render/**": [
      "./node_modules/ffmpeg-static/**",
      "./node_modules/@remotion/compositor-linux-x64-gnu/**",
      "./src/remotion/**",
      "./src/components/snippy/**",
    ],
    "/api/snippy-transcribe/**": ["./node_modules/ffmpeg-static/**"],
    "/api/snippy-clip/**": ["./node_modules/ffmpeg-static/**"],
  },
  env: {
    BUILD_VERSION: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
    BUILD_TIME: new Date().toISOString(),
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "img.youtube.com",
      },
    ],
  },
};

export default nextConfig;
