
// runtime: Node for BigQuery; cache for 1 hour
export const runtime = "nodejs";
export const revalidate = 3600;

import { NextResponse } from "next/server";
import { fetchTranscript } from "@/lib/bigquery";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const data = await fetchTranscript(params.id);
  return NextResponse.json(data ?? [], { status: 200 });
}
