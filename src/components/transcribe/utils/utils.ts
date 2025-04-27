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
      // Format timestamp (seconds) to [MM:SS]
      const minutes = Math.floor(snippet.start / 60);
      const seconds = Math.floor(snippet.start % 60);
      const timestamp = `[${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")}]`;

      return `${timestamp} ${snippet.text}`;
    })
    .join("\n\n");
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
  const minutes = Math.floor(timeInSeconds / 60);
  const seconds = Math.floor(timeInSeconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
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
