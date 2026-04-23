import path from "path";
import fs from "fs";
import os from "os";
import { NextResponse } from "next/server";
import type { OverlaySettings, WordTimestamp, CaptionStyle } from "@/components/snippy/types";
import { pretrimToLocal, safeUnlink } from "./pretrim";

export const maxDuration = 300;
export const runtime = "nodejs";

let cachedBundle: string | null = null;

async function getBundle(): Promise<string> {
  if (cachedBundle) return cachedBundle;
  const { bundle } = await import("@remotion/bundler");
  const entryPoint = path.resolve(process.cwd(), "src/remotion/root.tsx");
  const outDir = path.join(os.tmpdir(), "snippy-remotion-bundle");
  console.log(`[snippy-render] Bundling from: ${entryPoint} -> ${outDir}`);
  const bundled = await bundle({
    entryPoint,
    outDir,
    webpackOverride: (config) => {
      // Lambda /var/task is read-only; webpack's default filesystem cache
      // tries to write to node_modules/.cache. Disable it.
      config.cache = false;
      return config;
    },
  });
  cachedBundle = bundled;
  console.log(`[snippy-render] Bundle cached: ${bundled}`);
  return bundled;
}

interface RenderBody {
  videoUrl: string;
  startSec: number;
  endSec: number;
  overlays?: OverlaySettings[];
  captions?: WordTimestamp[];
  captionStyle?: CaptionStyle;
  filenameHint?: string;
  resolution?: 720 | 1080;
}

export async function POST(request: Request) {
  const body = (await request.json()) as RenderBody;
  const {
    videoUrl: sourceUrl,
    startSec,
    endSec,
    overlays,
    captions,
    captionStyle,
    filenameHint,
    resolution = 1080,
  } = body;

  if (!sourceUrl || startSec == null || endSec == null) {
    return NextResponse.json(
      { error: "Missing videoUrl, startSec, or endSec" },
      { status: 400 }
    );
  }
  if (endSec <= startSec) {
    return NextResponse.json(
      { error: "endSec must be greater than startSec" },
      { status: 400 }
    );
  }

  const fps = 30;
  const clipDurationSec = endSec - startSec;
  const durationInFrames = Math.max(1, Math.round(clipDurationSec * fps));
  const outputPath = path.join(os.tmpdir(), `snippy-out-${Date.now()}.mp4`);

  let clipPath: string | null = null;
  console.log(
    `[snippy-render] Start: ${sourceUrl} ${startSec}-${endSec} (${durationInFrames} frames)`
  );

  try {
    const pretrim = await pretrimToLocal(sourceUrl, startSec, endSec);
    clipPath = pretrim.filePath;
    const origin =
      request.headers.get("origin") ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
    const localVideoUrl = `${origin.replace(/\/$/, "")}/api/snippy-clip/${pretrim.clipId}`;

    const { renderMedia, selectComposition } = await import("@remotion/renderer");
    const bundled = await getBundle();

    let browserExecutable: string | undefined;
    if (process.env.VERCEL) {
      try {
        const chromium = (await import("@sparticuz/chromium-min")).default;
        browserExecutable = await chromium.executablePath(
          "https://github.com/nichochar/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar"
        );
        console.log(`[snippy-render] Using serverless Chromium: ${browserExecutable}`);
      } catch (e) {
        console.warn("[snippy-render] @sparticuz/chromium-min not available, using default browser");
      }
    }

    const inputProps = {
      videoUrl: localVideoUrl,
      trimStartSec: pretrim.preRollSec,
      inSec: 0,
      outSec: clipDurationSec,
      overlays: overlays || [],
      captions: captions || [],
      captionStyle,
    };

    const compositionId = resolution === 720 ? "SnippyComposition720" : "SnippyComposition";
    const composition = await selectComposition({
      serveUrl: bundled,
      id: compositionId,
      inputProps,
    });

    composition.durationInFrames = durationInFrames;

    console.log(
      `[snippy-render] Rendering ${composition.durationInFrames} frames at ${composition.width}x${composition.height}`
    );

    await renderMedia({
      composition,
      serveUrl: bundled,
      codec: "h264",
      crf: 18,
      pixelFormat: "yuv420p",
      outputLocation: outputPath,
      inputProps,
      browserExecutable,
      timeoutInMilliseconds: 60_000,
      onProgress: ({ progress }) => {
        const pct = Math.round(progress * 100);
        if (pct % 10 === 0) {
          console.log(`[snippy-render] Progress: ${pct}%`);
        }
      },
    });

    console.log(`[snippy-render] Render complete: ${outputPath}`);

    const stat = fs.statSync(outputPath);
    const filename = filenameHint
      ? `${filenameHint}.mp4`
      : `snippy-${Math.round(startSec)}-${Math.round(endSec)}.mp4`;

    const clipForCleanup = clipPath;
    const nodeStream = fs.createReadStream(outputPath);
    nodeStream.on("close", () => {
      fs.promises.unlink(outputPath).catch(() => {});
      if (clipForCleanup) safeUnlink(clipForCleanup);
    });

    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeStream.on("data", (chunk: string | Buffer) => {
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          controller.enqueue(new Uint8Array(buf));
        });
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });

    return new Response(webStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(stat.size),
      },
    });
  } catch (err) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}
    if (clipPath) safeUnlink(clipPath);
    const msg = err instanceof Error ? err.message : "Render failed";
    console.error(`[snippy-render] Error:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
