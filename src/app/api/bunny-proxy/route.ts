import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const BUNNY_REFERER = "https://iframe.mediadelivery.net/";
const ALLOWED_HOST_SUFFIX = ".b-cdn.net";

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src");
  if (!src) {
    return new Response("Missing src", { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(src);
  } catch {
    return new Response("Invalid src", { status: 400 });
  }
  if (!target.hostname.endsWith(ALLOWED_HOST_SUFFIX)) {
    return new Response("Host not allowed", { status: 403 });
  }

  const forwardHeaders: HeadersInit = { Referer: BUNNY_REFERER };
  const range = req.headers.get("range");
  if (range) (forwardHeaders as Record<string, string>).Range = range;

  const upstream = await fetch(target.toString(), {
    headers: forwardHeaders,
    redirect: "follow",
    cache: "no-store",
  });

  const headers = new Headers();
  for (const h of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
  ]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function HEAD(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src");
  if (!src) return new Response(null, { status: 400 });
  const upstream = await fetch(src, {
    method: "HEAD",
    headers: { Referer: BUNNY_REFERER },
  });
  const headers = new Headers();
  for (const h of ["content-type", "content-length", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(null, { status: upstream.status, headers });
}
