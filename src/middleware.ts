import { NextRequest, NextResponse } from "next/server";

const NOINDEX = "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai";

// SHA-256 of the active EXPENSES_TOKEN. The plaintext token is never committed.
// Rotate by computing a new hash and updating this constant.
const EXPENSES_TOKEN_SHA256 =
  "f5025729ea4d8ce657c035ceba65127cd36242f92602020fd61f6d086b2e5ed5";

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;
  if (pathname === "/expenses" || pathname === "/api/expenses") {
    const provided = searchParams.get("key") ?? "";
    const providedHash = provided ? await sha256Hex(provided) : "";
    if (!timingSafeEqualHex(providedHash, EXPENSES_TOKEN_SHA256)) {
      return new NextResponse("Not found", { status: 404 });
    }
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", NOINDEX);
    return res;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/expenses", "/api/expenses"],
};
