import OpenAI from "openai";
import { Transcript } from "./types";
import { JWT } from "google-auth-library";
import { google, sheets_v4 } from "googleapis";

export function formatDuration(isoDuration: string): string {
  // Regular expressions to extract hours, minutes, and seconds
  const hourRegex = /(\d+)H/;
  const minuteRegex = /(\d+)M/;
  const secondRegex = /(\d+)S/;

  // Extract values
  const hours = hourRegex.test(isoDuration)
    ? parseInt(isoDuration.match(hourRegex)![1])
    : 0;
  const minutes = minuteRegex.test(isoDuration)
    ? parseInt(isoDuration.match(minuteRegex)![1])
    : 0;
  const seconds = secondRegex.test(isoDuration)
    ? parseInt(isoDuration.match(secondRegex)![1])
    : 0;

  // Format as HH:MM:SS or MM:SS depending on whether hours exist
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  } else {
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
}

export function extractVideoId(url: string): string | null {
  const regExp =
    /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[7].length === 11 ? match[7] : null;
}

function deduplicateAndFormatNames(namesString: string): string {
  if (!namesString) return "";

  // Split by commas, clean each name, and filter out empty strings
  const namesList = namesString
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  // Create a Set to automatically deduplicate (case-insensitive)
  const uniqueNames = new Set<string>();

  // Add each normalized name to the set
  namesList.forEach((name) => {
    // Normalize to lowercase for comparison, but keep original for display
    const normalizedName = name.toLowerCase();
    if (
      !Array.from(uniqueNames).some((n) => n.toLowerCase() === normalizedName)
    ) {
      uniqueNames.add(name);
    }
  });

  // Convert back to sorted comma-separated string
  return Array.from(uniqueNames).sort().join(", ");
}

export async function extractHumanNames(
  speakerName: string,
  videoTitle: string,
  videoDescription: string
): Promise<string> {
  try {
    const client = new OpenAI();
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `EXTRACT HUMAN NAMES ONLY: Extract all unique human names from the following content. 
          Rules:
          1) Identify full names (first and last name)
          2) Remove any duplicates - each person should appear only once
          3) Handle cases where the same person is mentioned in different fields
          4) Include only actual people, not organizations or titles
          5) Format response as a simple CSV list: "FirstName LastName, FirstName2 LastName2"
          6) Do not include any additional notes or formatting
  
          Speaker field: ${speakerName}
          Video title: ${videoTitle}
          Description: ${videoDescription}
  
          RETURN ONLY: A deduplicated, comma-separated list of human names (first+last name only) found across all fields. Return CSV format only, no additional text.`,
        },
      ],
    });

    let extractedNames = response.choices[0].message.content?.trim();
    if (!extractedNames) {
      throw new Error("No names extracted");
    }
    extractedNames = deduplicateAndFormatNames(extractedNames);
    return extractedNames;
  } catch (error) {
    console.error("Error extracting human names:", error);
    return "";
  }
}

export async function identifySpeakers(
  transcriptText: string,
  videoTitle: string,
  videoDescription: string,
  userSpeaker: string,
  channelName?: string
): Promise<string> {
  try {
    const client = new OpenAI();
    const transcriptSample = transcriptText.slice(0, 20000);

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are identifying speakers in a video transcript.

Given a transcript excerpt, video title, channel name, description, and user-provided speaker names, identify ALL people who are actually SPEAKING in this video.

Rules:
1. The user-provided speaker field may contain multiple comma-separated names. These are strong candidates who very likely speak in this video — include them in your output UNLESS there is clear evidence they do not actually speak (e.g., the person is deceased, is only discussed as a topic, or is clearly not a participant in this recording). When in doubt, include them.
2. Analyze the transcript for additional speakers: look for introductions, self-references, conversational cues (e.g., "thank you Sam", host introductions), and back-and-forth dialogue patterns.
3. For additional speakers beyond the user-provided ones, only include them if you have 90%+ confidence they are actually speaking, not merely mentioned or discussed.
4. Use full names (first + last) when identifiable. When the transcript uses informal or shortened names (e.g., "Clay and Buck"), cross-reference with the channel name, title, and description to resolve to full names (e.g., "Clay Travis, Buck Sexton").
5. Return ONLY a comma-separated list of names, nothing else.`,
        },
        {
          role: "user",
          content: `User-provided speaker(s): ${userSpeaker}
Video title: ${videoTitle}
Channel name: ${channelName || "Unknown"}
Description (first 500 chars): ${videoDescription.slice(0, 500)}

Transcript excerpt:
${transcriptSample}

Return ONLY the comma-separated list of confirmed speakers (90%+ confidence):`,
        },
      ],
    });

    let names = response.choices[0].message.content?.trim();
    if (!names) return userSpeaker;
    return deduplicateAndFormatNames(names);
  } catch (error) {
    console.error("Error identifying speakers:", error);
    return userSpeaker;
  }
}

function stripPromptArtifacts(text: string): string {
  if (!text) return "";
  return text
    .replace(/\b(the\s+name\s+is|speaker\s*:?|output\s*:?|return\s+only\s*:?)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isAllowedSingleTokenName(name: string): boolean {
  const n = name.trim().toLowerCase();
  // Celebrity/stage-name exceptions that are valid speaker outputs.
  return ["will.i.am", "will i am", "william adams"].includes(n);
}

function hasSpeakerContextForName(name: string, title: string, description: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;

  const text = `${title || ""} ${description || ""}`.toLowerCase();
  const idx = text.indexOf(n);
  if (idx === -1) return false;

  // Take a small context window around the name and look for speaker-role cues.
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + n.length + 80);
  const ctx = text.slice(start, end);

  const cues = [
    "with",
    "interview",
    "in conversation",
    "conversation with",
    "hosted by",
    "host",
    "guest",
    "featuring",
    "featuring",
    "talks with",
    "fireside",
    "podcast",
    "q&a",
    "debate",
    "panel",
    "speaks",
    "speech",
    "lecture",
    "discusses",
  ];

  return cues.some((c) => ctx.includes(c));
}

export async function verifyAndCleanSpeakers(
  transcriptText: string,
  videoTitle: string,
  videoDescription: string,
  userSpeaker: string,
  identifiedSpeakers: string,
  channelName?: string
): Promise<string> {
  const candidateList = deduplicateAndFormatNames(
    stripPromptArtifacts(identifiedSpeakers || ""),
  )
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  // If pass 2 gave nothing, pass 3 cannot invent speakers.
  if (candidateList.length === 0) return "";

  const candidateSet = new Set(candidateList.map((n) => n.toLowerCase()));

  try {
    const client = new OpenAI();
    const transcriptSample = transcriptText.slice(0, 20000);

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a strict final QA pass for speaker names.\n\nCRITICAL CONSTRAINT: You may ONLY keep or remove names from the provided candidate list.\nDo NOT add new names under any circumstance.\n\nYour job:\n1) Keep ONLY people from candidate list who are actually speaking in this video.\n2) Remove obvious prompt artifacts/fragments (examples: "the name is", "speaker:", cut-off prompt junk).\n3) Remove obvious deceased historical figures clearly discussed but not present in this recording.\n4) Output ONLY names from candidate list in CSV format.\n5) Preferred format is First Last (middle allowed).\n6) Single-token/stage names are normally excluded EXCEPT known valid stage names from candidates (e.g., "will.i.am").\n7) No titles or organizations. Deduplicate.\n8) If uncertain, exclude.\n\nReturn ONLY a comma-separated list of kept names (subset of candidates).`,
        },
        {
          role: "user",
          content: `Candidate list (pass 2): ${candidateList.join(", ")}\nUser speaker input: ${userSpeaker}\nVideo title: ${videoTitle}\nChannel name: ${channelName || "Unknown"}\nDescription (first 500 chars): ${videoDescription.slice(0, 500)}\n\nTranscript excerpt:\n${transcriptSample}\n\nReturn ONLY the kept names as CSV (must be a subset of candidate list).`,
        },
      ],
    });

    const raw = response.choices[0].message.content?.trim() || "";
    const cleaned = deduplicateAndFormatNames(stripPromptArtifacts(raw));

    // Enforce at least two tokens and enforce strict subset of candidate list.
    const keptByModel = cleaned
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.split(/\s+/).length >= 2 || isAllowedSingleTokenName(n))
      .filter((n) => candidateSet.has(n.toLowerCase()));

    // Guardrail: keep pass-2 candidates when metadata discusses them as speakers.
    // (Not just mentioned — must have speaker-role context near the name.)
    const rescueFromMetadata = candidateList.filter((n) =>
      hasSpeakerContextForName(n, videoTitle, videoDescription),
    );

    const finalNames = deduplicateAndFormatNames(
      [...keptByModel, ...rescueFromMetadata].join(", "),
    )
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.split(/\s+/).length >= 2 || isAllowedSingleTokenName(n))
      .filter((n) => candidateSet.has(n.toLowerCase()))
      .join(", ");

    return finalNames;
  } catch (error) {
    console.error("Error in third-pass speaker verification:", error);
    // Safe fallback: clean pass2 only, never add.
    return candidateList
      .filter((n) => n.split(/\s+/).length >= 2 || isAllowedSingleTokenName(n))
      .join(", ");
  }
}

export function formatTranscriptAsText(transcript: Transcript): string {
  if (
    !transcript ||
    !transcript.transcript_data ||
    !Array.isArray(transcript.transcript_data)
  ) {
    return "No transcript available for this video."; // Return message if there's no valid transcript data
  }

  if (transcript.transcript_data.length === 0) {
    return "No transcript available for this video.";
  }

  return transcript.transcript_data
    .map((snippet) => {
      const hours = Math.floor(snippet.start / 3600);
      const minutes = Math.floor((snippet.start % 3600) / 60);
      const seconds = Math.floor(snippet.start % 60);
      const timestamp = hours > 0
        ? `[${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}]`
        : `[${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}]`;

      return `${timestamp} ${snippet.text}`;
    })
    .join("\n");
}

/**
 * Format transcript as SRT (SubRip Text)
 */
export function formatTranscriptAsSRT(transcript: Transcript): string {
  if (
    !transcript ||
    !transcript.transcript_data ||
    !Array.isArray(transcript.transcript_data)
  ) {
    return "1\n00:00:00,000 --> 00:00:01,000\nNo transcript available for this video.\n";
  }

  if (transcript.transcript_data.length === 0) {
    return "1\n00:00:00,000 --> 00:00:01,000\nNo transcript available for this video.\n";
  }

  return transcript.transcript_data
    .map((snippet, index) => {
      const startTime = formatSRTTime(snippet.start);
      const endTime = formatSRTTime(snippet.start + snippet.duration);

      return `${index + 1}\n${startTime} --> ${endTime}\n${snippet.text}\n`;
    })
    .join("\n");
}

function formatSRTTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds - Math.floor(seconds)) * 1000);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(secs).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function formatTimestamp(timeInSeconds: number): string {
  const hours = Math.floor(timeInSeconds / 3600);
  const minutes = Math.floor((timeInSeconds % 3600) / 60);
  const seconds = Math.floor(timeInSeconds % 60);
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export async function getGoogleDocsAuth() {
  try {
    // Get service account credentials
    const serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

    if (!serviceAccount) {
      throw new Error("Google service account credentials are not configured");
    }

    // Parse service account credentials
    const serviceAccountContent = JSON.parse(serviceAccount);

    // Create JWT auth client
    const auth = new JWT({
      email: serviceAccountContent.client_email,
      key: serviceAccountContent.private_key,
      scopes: [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive",
      ],
    });

    // Create and return Docs API client
    return google.docs({ version: "v1", auth });
  } catch (error) {
    console.error("Error creating Google Docs client:", error);
    throw error;
  }
}

export async function getGoogleSheetsAuth() {
  try {
    // Get service account credentials
    const serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

    if (!serviceAccount) {
      throw new Error("Google service account credentials are not configured");
    }

    // Parse service account credentials
    const serviceAccountContent = JSON.parse(serviceAccount);

    // Create JWT auth client
    const auth = new JWT({
      email: serviceAccountContent.client_email,
      key: serviceAccountContent.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    // Create and return Sheets API client
    return google.sheets({ version: "v4", auth });
  } catch (error) {
    console.error("Error creating Google Sheets client:", error);
    throw error;
  }
}

export async function addHeadersToSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string
): Promise<void> {
  try {
    // First, get information about the spreadsheet to find if our sheet exists
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    // Check if YouTubeMetadata sheet already exists
    let sheetExists = false;
    let sheetId = 0;

    if (spreadsheet.data.sheets) {
      for (const sheet of spreadsheet.data.sheets) {
        if (sheet.properties?.title === "YouTubeMetadata") {
          sheetExists = true;
          sheetId = sheet.properties.sheetId || 0;
          break;
        }
      }
    }

    // If the sheet doesn't exist, create it
    if (!sheetExists) {
      console.log("Creating new YouTubeMetadata sheet");
      const addSheetResponse = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: "YouTubeMetadata",
                },
              },
            },
          ],
        },
      });

      // Get the new sheet ID
      if (
        addSheetResponse.data.replies &&
        addSheetResponse.data.replies[0].addSheet
      ) {
        sheetId =
          addSheetResponse.data.replies[0].addSheet.properties?.sheetId || 0;
      }
    }

    // Add headers
    const headers = [
      [
        "YouTube Link",
        "Video ID",
        "Title",
        "Speaker",
        "Channel",
        "Channel ID",
        "Published Date",
        "Duration",
        "View Count",
        "Description",
        "Corrected Names",
        "Transcript Doc",
      ],
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "YouTubeMetadata!A1:L1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: headers,
      },
    });

    // Format headers (make them bold)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: 12,
              },
              cell: {
                userEnteredFormat: {
                  textFormat: {
                    bold: true,
                  },
                  backgroundColor: {
                    red: 0.9,
                    green: 0.9,
                    blue: 0.9,
                  },
                },
              },
              fields: "userEnteredFormat(textFormat,backgroundColor)",
            },
          },
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheetId,
                gridProperties: {
                  frozenRowCount: 1,
                },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error("Error setting up sheet headers:", error);
    throw error;
  }
}
