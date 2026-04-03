export const runtime = "nodejs";
export const revalidate = 3600;

import { NextRequest, NextResponse } from "next/server";
import { fetchAutoSnippets } from "@/lib/bigquery";

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json([], { status: 200 });
  }
  const snippets = await fetchAutoSnippets(videoId);
  return NextResponse.json(snippets, { status: 200 });
}
