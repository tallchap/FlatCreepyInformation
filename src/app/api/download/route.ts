
// run on the Node runtime (not edge) because we spawn a binary
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getVideo } from "@/lib/fetch-youtube";

export async function POST() {
  const mp4 = await getVideo();

  return new NextResponse(mp4, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="video.mp4"',
      "Content-Length": mp4.byteLength.toString(),
    },
  });
}
