import { NextRequest, NextResponse } from "next/server";
import { Storage } from "@google-cloud/storage";
import { google } from "googleapis";

export const runtime = "nodejs";

const BUCKET_NAME = "snippysaurus-clips";

function getCredentials() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON");
  try {
    return JSON.parse(raw);
  } catch {
    const fixed = raw.replace(
      /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
      (_m: string, key: string) =>
        `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
    );
    return JSON.parse(fixed);
  }
}

async function uploadScreenshot(base64Data: string): Promise<string> {
  const credentials = getCredentials();
  const storage = new Storage({ credentials, projectId: credentials.project_id });

  // Strip data URL prefix if present
  const base64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64, "base64");

  const timestamp = Date.now();
  const gcsPath = `feedback/screenshot-${timestamp}.jpg`;
  const file = storage.bucket(BUCKET_NAME).file(gcsPath);

  await file.save(buffer, {
    metadata: {
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000",
    },
  });

  return `https://storage.googleapis.com/${BUCKET_NAME}/${gcsPath}`;
}

async function appendToSheet(row: string[]) {
  const sheetId = process.env.FEEDBACK_SHEET_ID;
  if (!sheetId) throw new Error("Missing FEEDBACK_SHEET_ID");

  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Sheet1!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [row],
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const { text, email, screenshotBase64, pageUrl, userAgent } = await req.json();

    if (!text?.trim()) {
      return NextResponse.json({ error: "Feedback text is required" }, { status: 400 });
    }
    if (!email?.trim()) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    let screenshotUrl = "";
    if (screenshotBase64) {
      screenshotUrl = await uploadScreenshot(screenshotBase64);
    }

    const timestamp = new Date().toISOString();
    await appendToSheet([
      timestamp,
      pageUrl || "",
      text.trim(),
      email.trim(),
      screenshotUrl,
      userAgent || "",
    ]);

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Feedback submission failed";
    console.error("Feedback error:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
