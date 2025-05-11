// src/app/api/download/route.ts
import { NextResponse } from "next/server";
import { getVideo } from "@/lib/fetch-youtube";

export const runtime = "nodejs";

export async function POST() {
  const mp4 = await getVideo(); // or getVideo(customUrl)

  return new NextResponse(mp4, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="video.mp4"',
      "Content-Length": mp4.byteLength.toString(),
    },
  });
}
