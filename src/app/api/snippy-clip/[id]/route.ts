import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";

function sanitizeId(raw: string): string | null {
  // Only allow the expected pattern produced by pretrim: `<timestamp>-<8-char-suffix>`
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(raw)) return null;
  return raw;
}

function resolveFilePath(id: string): string {
  return path.join(os.tmpdir(), `snippy-src-${id}.mp4`);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const safe = sanitizeId(id);
  if (!safe) return new NextResponse("bad id", { status: 400 });

  const filePath = resolveFilePath(safe);
  if (!fs.existsSync(filePath)) {
    return new NextResponse("not found", { status: 404 });
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.get("range");

  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (!m) return new NextResponse("bad range", { status: 416 });
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : stat.size - 1;
    if (start > end || end >= stat.size)
      return new NextResponse("bad range", { status: 416 });
    const chunkSize = end - start + 1;
    const nodeStream = fs.createReadStream(filePath, { start, end });
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeStream.on("data", (c: string | Buffer) =>
          controller.enqueue(
            new Uint8Array(typeof c === "string" ? Buffer.from(c) : c)
          )
        );
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (e) => controller.error(e));
      },
      cancel() {
        nodeStream.destroy();
      },
    });
    return new Response(webStream, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const nodeStream = fs.createReadStream(filePath);
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (c: string | Buffer) =>
        controller.enqueue(
          new Uint8Array(typeof c === "string" ? Buffer.from(c) : c)
        )
      );
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (e) => controller.error(e));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
    },
  });
}
