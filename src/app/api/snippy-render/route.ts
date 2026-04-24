import fs from "fs";
import { NextResponse } from "next/server";
import type { OverlaySettings, WordTimestamp, CaptionStyle } from "@/components/snippy/types";
import { pretrimToLocal, safeUnlink } from "./pretrim";

export const maxDuration = 300;
export const runtime = "nodejs";

async function uploadClipToS3(filePath: string, bucketName: string, region: string): Promise<{ url: string; sizeMB: string }> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region });
  const key = `video-sources/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const body = fs.readFileSync(filePath);
  const sizeMB = (body.length / 1024 / 1024).toFixed(1);
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body, ContentType: "video/mp4" }));
  const url = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
  return { url, sizeMB };
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
    return NextResponse.json({ error: "Missing videoUrl, startSec, or endSec" }, { status: 400 });
  }
  if (endSec <= startSec) {
    return NextResponse.json({ error: "endSec must be greater than startSec" }, { status: 400 });
  }

  const region = (process.env.REMOTION_AWS_REGION || "us-west-2").trim() as "us-west-2";
  const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME?.trim();
  const serveUrl = process.env.REMOTION_SERVE_URL?.trim();

  if (!functionName || !serveUrl) {
    return NextResponse.json(
      { error: "Remotion Lambda not configured (missing env vars)" },
      { status: 500 }
    );
  }

  const fps = 30;
  const clipDurationSec = endSec - startSec;
  const durationInFrames = Math.max(1, Math.round(clipDurationSec * fps));
  const compositionId = resolution === 720 ? "SnippyComposition720" : "SnippyComposition";

  const encoder = new TextEncoder();
  const emit = (controller: ReadableStreamDefaultController, data: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      let clipPath: string | null = null;
      try {
        const { renderMediaOnLambda, getRenderProgress } = await import("@remotion/lambda/client");

        emit(controller, { log: `Pretrimming ${clipDurationSec.toFixed(1)}s clip @ ${resolution}p...` });
        const pretrim = await pretrimToLocal(sourceUrl, startSec, endSec);
        clipPath = pretrim.filePath;
        const clipSize = (fs.statSync(pretrim.filePath).size / 1024 / 1024).toFixed(1);
        emit(controller, { log: `Pretrim complete: ${clipSize} MB` });

        emit(controller, { log: "Uploading clip to S3..." });
        const bucketName = (process.env.REMOTION_S3_BUCKET || "remotionlambda-uswest2-4dxol9yt1q").trim();
        const { url: s3VideoUrl, sizeMB } = await uploadClipToS3(pretrim.filePath, bucketName, region);
        emit(controller, { log: `S3 upload complete: ${sizeMB} MB → ${s3VideoUrl.split("/").pop()}` });

        const inputProps = {
          videoUrl: s3VideoUrl,
          trimStartSec: pretrim.preRollSec,
          inSec: 0,
          outSec: clipDurationSec,
          overlays: overlays || [],
          captions: captions || [],
          captionStyle,
        };

        emit(controller, { log: `Dispatching Lambda render: ${durationInFrames} frames, ${compositionId}...` });
        const render = await renderMediaOnLambda({
          region,
          functionName,
          serveUrl,
          composition: compositionId,
          inputProps,
          forceDurationInFrames: durationInFrames,
          codec: "h264",
          crf: 18,
          framesPerLambda: Math.max(20, Math.ceil(durationInFrames / 180)),
          downloadBehavior: {
            type: "download",
            fileName: filenameHint ? `${filenameHint}.mp4` : `snippy-${Math.round(startSec)}-${Math.round(endSec)}.mp4`,
          },
        });
        emit(controller, { log: `Render dispatched: ${render.renderId}` });

        let done = false;
        let lastPct = -1;
        while (!done) {
          const progress = await getRenderProgress({
            renderId: render.renderId,
            bucketName: render.bucketName,
            functionName,
            region,
          });

          if (progress.fatalErrorEncountered) {
            const errMsg = progress.errors?.[0]?.message || "Lambda render failed";
            emit(controller, { log: `ERROR: ${errMsg}`, error: errMsg });
            break;
          }

          const pct = Math.round((progress.overallProgress ?? 0) * 100);
          if (pct !== lastPct) {
            emit(controller, { progress: pct, log: `Lambda progress: ${pct}%` });
            lastPct = pct;
          }

          if (progress.done && progress.outputFile) {
            emit(controller, { done: true, url: progress.outputFile, progress: 100, log: `Render complete: ${progress.outputFile}` });
            done = true;
          } else {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Render failed";
        emit(controller, { log: `ERROR: ${msg}`, error: msg });
      } finally {
        if (clipPath) safeUnlink(clipPath);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
