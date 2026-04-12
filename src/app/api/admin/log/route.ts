import { NextRequest, NextResponse } from "next/server";
import { readEvents } from "@/lib/pipeline-log";

export const dynamic = "force-dynamic";

function authOk(req: NextRequest): boolean {
  const expected = process.env.ADMIN_PATH_SECRET;
  if (!expected) return false;
  const key = req.nextUrl.searchParams.get("key");
  return !!key && key === expected;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return new NextResponse("Unauthorized", { status: 401, headers: { "X-Robots-Tag": "noindex, nofollow" } });
  }
  const page = parseInt(req.nextUrl.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(req.nextUrl.searchParams.get("pageSize") || "50", 10);
  const videoId = req.nextUrl.searchParams.get("videoId");
  const result = await readEvents({ page, pageSize, videoId: videoId || null });
  return NextResponse.json(result, { headers: { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" } });
}
