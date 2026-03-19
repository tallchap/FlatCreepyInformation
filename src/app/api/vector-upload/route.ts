import { uploadToVectorStore } from "@/components/transcribe/utils/vector-upload";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    await uploadToVectorStore(body);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Vector upload API error:", error);
    return NextResponse.json(
      { error: error?.message || "Vector upload failed" },
      { status: 500 }
    );
  }
}
