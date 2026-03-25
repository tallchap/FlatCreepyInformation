import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

const PROJECT = "youtubetranscripts-429803";
const REGION = "us-central1";
const JOB = "gcs-downloader";

export async function POST(req: NextRequest) {
  try {
    const { videoId } = await req.json();
    if (!videoId || typeof videoId !== "string" || !/^[\w-]{11}$/.test(videoId)) {
      return NextResponse.json({ error: "Invalid videoId" }, { status: 400 });
    }

    const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credJson) {
      return NextResponse.json({ error: "Missing GCP credentials" }, { status: 500 });
    }

    const creds = JSON.parse(credJson);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const accessToken = await auth.getAccessToken();

    const url = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        overrides: {
          taskCount: 1,
          containerOverrides: [
            {
              env: [
                { name: "VIDEO_ID", value: videoId },
                { name: "BATCH_SIZE", value: "1" },
                { name: "MAX_CONCURRENT", value: "1" },
              ],
            },
          ],
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Cloud Run API error:", res.status, text);
      return NextResponse.json({ error: `Cloud Run API ${res.status}: ${text}` }, { status: 502 });
    }

    const data = await res.json();
    const executionName = data.metadata?.name || data.name || "unknown";
    console.log(`Triggered GCS download for ${videoId}: ${executionName}`);

    return NextResponse.json({ ok: true, execution: executionName, videoId });
  } catch (error: any) {
    console.error("Trigger download error:", error);
    return NextResponse.json({ error: error?.message || "Failed to trigger download" }, { status: 500 });
  }
}
