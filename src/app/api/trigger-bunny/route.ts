import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { logEvent } from "@/lib/pipeline-log";

/* ─────────────────────────────────────────────────────────────────────────────
 * Fires Cloud Run Job `bunny-downloader`. To hide its ~2min cold-start from
 * the user, we do a single-shot RapidAPI init here on warm Vercel and pass
 * the resulting progress_url to the Job. Cloud Run skips its own init and
 * jumps straight into the poll loop. Full poll + Bunny fetch + encode wait
 * stay on Cloud Run (4 h timeout) — only the init moves here.
 *
 * If the Vercel init fails for any reason, we still fire Cloud Run without
 * PROGRESS_URL and Cloud Run's existing retry-with-backoff handles it from
 * scratch (backward-compatible path).
 * ──────────────────────────────────────────────────────────────────────────── */

export const maxDuration = 30;

const PROJECT = "youtubetranscripts-429803";
const REGION = "us-central1";
const JOB = "bunny-downloader";
const RAPIDAPI_HOST = "youtube-info-download-api.p.rapidapi.com";
const INIT_QUALITY = "1080";

type InitResult = { progressUrl: string; quality: string } | null;

async function rapidapiInitSingleShot(videoId: string): Promise<InitResult> {
  const key = (process.env.RAPIDAPI_KEY || "").trim();
  if (!key) return null;
  const params = new URLSearchParams({
    format: INIT_QUALITY,
    add_info: "0",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    allow_extended_duration: "1",
    no_merge: "false",
  });
  const url = `https://${RAPIDAPI_HOST}/ajax/download.php?${params}`;
  try {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": RAPIDAPI_HOST,
        "x-rapidapi-key": key,
      },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.success || !data.progress_url) return null;
    return { progressUrl: data.progress_url, quality: INIT_QUALITY };
  } catch {
    return null;
  }
}

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

    // Single-shot RapidAPI init on Vercel — hides Cloud Run cold-start from
    // the user. If this fails, Cloud Run re-inits from scratch.
    const init = await rapidapiInitSingleShot(videoId);
    if (init) {
      await logEvent({ videoId, pipeline: "transcribe", step: "rapidapi-init", status: "info", detail: { quality: `${init.quality}p`, source: "vercel" } });
    }

    const creds = JSON.parse(credJson);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const accessToken = await auth.getAccessToken();

    const envVars = [
      { name: "MODE", value: "bunny-only" },
      { name: "VIDEO_ID", value: videoId },
      { name: "BATCH_SIZE", value: "1" },
      { name: "MAX_CONCURRENT", value: "1" },
    ];
    if (init) {
      envVars.push({ name: "PROGRESS_URL", value: init.progressUrl });
      envVars.push({ name: "QUALITY", value: init.quality });
    }

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
          containerOverrides: [{ env: envVars }],
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Cloud Run API error:", res.status, text);
      await logEvent({ videoId, pipeline: "transcribe", step: "bunny-trigger", status: "error", detail: `Cloud Run API ${res.status}: ${text.slice(0, 200)}` });
      return NextResponse.json({ error: `Cloud Run API ${res.status}: ${text}` }, { status: 502 });
    }

    const data = await res.json();
    const executionName = data.metadata?.name || data.name || "unknown";
    console.log(`[trigger-bunny] ${videoId}: Cloud Run ${JOB} → ${executionName} (preInit=${init ? init.quality + "p" : "no"})`);
    await logEvent({ videoId, pipeline: "transcribe", step: "bunny-trigger", status: "success", detail: { execution: executionName, job: JOB, preInit: init ? init.quality + "p" : null } });

    return NextResponse.json({ ok: true, execution: executionName, videoId, method: "cloud-run-bunny-only", preInit: init?.quality || null });
  } catch (error: any) {
    console.error("Trigger bunny error:", error);
    return NextResponse.json({ error: error?.message || "Failed to trigger bunny" }, { status: 500 });
  }
}
