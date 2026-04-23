import { NextResponse } from "next/server";
import type { OverlaySettings, WordTimestamp, CaptionStyle } from "@/components/snippy/types";

export const maxDuration = 300;
export const runtime = "nodejs";

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

  const region = (process.env.REMOTION_AWS_REGION || "us-west-2") as "us-west-2";
  const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
  const serveUrl = process.env.REMOTION_SERVE_URL;

  if (!functionName || !serveUrl) {
    return NextResponse.json(
      { error: "Remotion Lambda not configured (missing REMOTION_LAMBDA_FUNCTION_NAME or REMOTION_SERVE_URL)" },
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

  try {
    const { renderMediaOnLambda, getRenderProgress } = await import("@remotion/lambda/client");

    const inputProps = {
      videoUrl: sourceUrl,
      trimStartSec: startSec,
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
      downloadBehavior: { type: "download", fileName: filenameHint ? `${filenameHint}.mp4` : `snippy-${Math.round(startSec)}-${Math.round(endSec)}.mp4` },
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
    const msg = err instanceof Error ? err.message : "Render failed";
    console.error(`[snippy-render] Error:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
