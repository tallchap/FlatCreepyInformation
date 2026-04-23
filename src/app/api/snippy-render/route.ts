import fs from "fs";
import { NextResponse } from "next/server";
import type { OverlaySettings, WordTimestamp, CaptionStyle } from "@/components/snippy/types";
import { pretrimToLocal, safeUnlink } from "./pretrim";

export const maxDuration = 300;
export const runtime = "nodejs";

async function uploadClipToS3(filePath: string, bucketName: string, region: string): Promise<string> {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region });
  const key = `video-sources/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  const body = fs.readFileSync(filePath);
  console.log(`[snippy-render] Uploading ${(body.length / 1024 / 1024).toFixed(1)} MB clip to S3...`);
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body, ContentType: "video/mp4" }));
  const s3Url = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
  console.log(`[snippy-render] Clip uploaded: ${s3Url}`);
  return s3Url;
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

  console.log(
    `[snippy-render] Lambda render: ${sourceUrl} ${startSec}-${endSec} (${durationInFrames} frames) @ ${resolution}p`
  );

  let clipPath: string | null = null;

  try {
    const { renderMediaOnLambda, getRenderProgress } = await import("@remotion/lambda/client");

    const pretrim = await pretrimToLocal(sourceUrl, startSec, endSec);
    clipPath = pretrim.filePath;
    const bucketName = (process.env.REMOTION_S3_BUCKET || "remotionlambda-uswest2-4dxol9yt1q").trim();
    const s3VideoUrl = await uploadClipToS3(pretrim.filePath, bucketName, region);

    const inputProps = {
      videoUrl: s3VideoUrl,
      trimStartSec: pretrim.preRollSec,
      inSec: 0,
      outSec: clipDurationSec,
      overlays: overlays || [],
      captions: captions || [],
      captionStyle,
    };

    const render = await renderMediaOnLambda({
      region,
      functionName,
      serveUrl,
      composition: compositionId,
      inputProps,
      codec: "h264",
      crf: 18,
      framesPerLambda: 20,
      downloadBehavior: {
        type: "download",
        fileName: filenameHint ? `${filenameHint}.mp4` : `snippy-${Math.round(startSec)}-${Math.round(endSec)}.mp4`,
      },
    });

    console.log(`[snippy-render] Render dispatched: ${render.renderId} bucket=${render.bucketName}`);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let done = false;
          while (!done) {
            const progress = await getRenderProgress({
              renderId: render.renderId,
              bucketName: render.bucketName,
              functionName,
              region,
            });

            if (progress.fatalErrorEncountered) {
              const errMsg = progress.errors?.[0]?.message || "Lambda render failed";
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`));
              controller.close();
              return;
            }

            const pct = Math.round((progress.overallProgress ?? 0) * 100);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ progress: pct })}\n\n`));

            if (progress.done && progress.outputFile) {
              console.log(`[snippy-render] Render complete: ${progress.outputFile}`);
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ done: true, url: progress.outputFile, progress: 100 })}\n\n`)
              );
              done = true;
            } else {
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Progress polling failed";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
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
  } catch (err) {
    if (clipPath) safeUnlink(clipPath);
    const msg = err instanceof Error ? err.message : "Render failed";
    console.error(`[snippy-render] Error:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
