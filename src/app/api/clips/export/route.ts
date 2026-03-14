import { NextRequest, NextResponse } from "next/server";
import { Storage } from "@google-cloud/storage";
import { bigQuery } from "@/lib/bigquery";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

const BUCKET_NAME = "snippysaurus-clips";
const DATASET = "reptranscripts";
const TABLE = "clips";

function getStorage() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON");
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    const fixed = raw.replace(
      /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
      (_m: string, key: string) =>
        `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
    );
    credentials = JSON.parse(fixed);
  }
  return new Storage({ credentials, projectId: credentials.project_id });
}

export async function POST(req: NextRequest) {
  try {
    const { videoId, clips } = await req.json();

    if (!videoId || !clips?.length) {
      return NextResponse.json({ error: "Missing videoId or clips" }, { status: 400 });
    }

    const storage = getStorage();
    const bucket = storage.bucket(BUCKET_NAME);
    const exported: string[] = [];

    for (const clip of clips) {
      const clipId = randomUUID().slice(0, 8);
      const gcsPath = `clips/${videoId}/${clipId}.mp4`;

      // Download clip MP4 from Vizard CDN
      const res = await fetch(clip.videoUrl);
      if (!res.ok) {
        throw new Error(`Failed to download clip: ${res.status} ${res.statusText}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());

      // Upload to GCS
      const file = bucket.file(gcsPath);
      await file.save(buffer, {
        metadata: {
          contentType: "video/mp4",
          cacheControl: "public, max-age=31536000",
        },
      });

      const gcsUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${gcsPath}`;

      // Insert into BigQuery
      const row = {
        clip_id: clipId,
        video_id: videoId,
        title: clip.title || "Untitled clip",
        category: clip.category || "viral",
        duration_ms: clip.videoMsDuration || 0,
        viral_score: parseFloat(clip.viralScore) || null,
        viral_reason: clip.viralReason || null,
        transcript: clip.transcript || null,
        speaker: null,
        gcs_url: gcsUrl,
        vizard_editor_url: clip.clipEditorUrl || null,
        created_at: new Date().toISOString(),
      };

      await bigQuery.dataset(DATASET).table(TABLE).insert([row]);
      exported.push(gcsUrl);
    }

    return NextResponse.json({ exported: exported.length, urls: exported });
  } catch (e: any) {
    console.error("Export error:", e);
    return NextResponse.json(
      { error: e.message || "Export failed" },
      { status: 500 }
    );
  }
}
