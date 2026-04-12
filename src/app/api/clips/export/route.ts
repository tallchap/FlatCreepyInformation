import { NextRequest, NextResponse } from "next/server";
import { Storage } from "@google-cloud/storage";
import { bigQuery } from "@/lib/bigquery";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

const BUCKET_NAME = "snippysaurus-clips";
const DATASET = "reptranscripts";

const SAFETY_KEYWORDS = [
  "ai safety", "alignment", "existential risk", "catastrophic", "superintelligence",
  "ai doom", "x-risk", "agi risk", "deceptive alignment", "ai control",
  "shutdown problem", "ai extinction", "ai risk", "ai threat", "ai regulation",
  "ai governance", "misalignment",
];

function isSafetyClip(clip: any): boolean {
  const text = [clip.relatedTopic, clip.title, clip.transcript]
    .filter(Boolean).join(" ").toLowerCase();
  return SAFETY_KEYWORDS.some(kw => text.includes(kw));
}

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
    const { videoId, allClips, selectedClips, projectId, creditsUsed } = await req.json();

    if (!videoId) {
      return NextResponse.json({ error: "Missing videoId" }, { status: 400 });
    }

    const now = new Date().toISOString();

    // Step 1: Save ALL clips to snippets_vizard (raw dump)
    if (allClips?.length) {
      const vizardRows = allClips.map((clip: any) => ({
        vizard_clip_id: clip.videoId,
        video_id: videoId,
        project_id: projectId || null,
        title: clip.title || null,
        transcript: clip.transcript || null,
        viral_score: parseFloat(clip.viralScore) || null,
        viral_reason: clip.viralReason || null,
        related_topic: clip.relatedTopic || null,
        duration_ms: clip.videoMsDuration || null,
        vizard_video_url: clip.videoUrl || null,
        vizard_editor_url: clip.clipEditorUrl || null,
        is_safety: isSafetyClip(clip),
        credits_used: creditsUsed || null,
        created_at: now,
      }));

      await bigQuery.dataset(DATASET).table("snippets_vizard").insert(vizardRows);
    }

    // Step 2: Export selected clips to GCS + snippets_auto
    const exported: string[] = [];
    const clipsToExport = selectedClips || [];

    if (clipsToExport.length > 0) {
      const storage = getStorage();
      const bucket = storage.bucket(BUCKET_NAME);

      for (const clip of clipsToExport) {
        const snippetId = randomUUID().slice(0, 8);
        const gcsPath = `clips/${videoId}/${snippetId}.mp4`;

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

        // Insert into snippets_auto
        const row = {
          snippet_id: snippetId,
          original_video_id: videoId,
          title: clip.title || "Untitled clip",
          description: clip.viralReason || null,
          category: clip.category || "viral",
          duration_ms: clip.videoMsDuration || 0,
          transcript: clip.transcript || null,
          gcs_url: gcsUrl,
          provider: "vizard",
          speaker: null,
          created_at: now,
        };

        await bigQuery.dataset(DATASET).table("snippets_auto").insert([row]);
        exported.push(gcsUrl);
      }
    }

    return NextResponse.json({
      vizardSaved: allClips?.length ?? 0,
      exported: exported.length,
      urls: exported,
    });
  } catch (e: any) {
    console.error("Export error:", e);
    return NextResponse.json(
      { error: e.message || "Export failed" },
      { status: 500 }
    );
  }
}
