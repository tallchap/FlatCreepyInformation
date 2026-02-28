import axios from "axios";
import {
  addHeadersToSheet,
  extractHumanNames,
  extractVideoId,
  formatDuration,
  formatTimestamp,
  formatTranscriptAsText,
  getGoogleDocsAuth,
  getGoogleSheetsAuth,
} from "./utils";
import { google, sheets_v4 } from "googleapis";
import { bigQuery } from "@/lib/bigquery";

export async function fetchYoutubeMetadata(url: string, speaker: string) {
  const videoId = extractVideoId(url);

  if (!videoId) {
    throw new Error("Could not extract video ID from the URL");
  }

  // Prepare the YouTube API URL with all the parts we need for metadata

  try {
    const response = await axios.get(
      `https://www.googleapis.com/youtube/v3/videos`,
      {
        params: {
          id: videoId,
          key: process.env.YOUTUBE_API_KEY || "",
          part: "snippet,contentDetails,statistics",
        },
      }
    );

    const data = await response.data;

    if (!data.items || data.items.length === 0) {
      throw new Error("Video not found");
    }

    const videoData = data.items[0];
    const snippet = videoData.snippet;
    const contentDetails = videoData.contentDetails;
    const statistics = videoData.statistics;

    // Format the date
    const publishedDate = snippet.publishedAt;

    // Convert ISO 8601 duration to human-readable format
    const duration = contentDetails?.duration || "PT0S";
    const durationStr = formatDuration(duration);

    // Extract human names using OpenAI
    const names = await extractHumanNames(
      speaker,
      snippet.title,
      snippet.description
    );

    return {
      id: 0, // This will be assigned by the database
      videoId,
      cleanUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title: snippet.title,
      description: snippet.description,
      channelName: snippet.channelTitle,
      channelId: snippet.channelId,
      publishedAt: publishedDate,
      duration: durationStr,
      viewCount: statistics?.viewCount || "0",
      speaker,
      extractedNames: names,
      createdAt: new Date(),
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to fetch video metadata");
  }
}

export async function fetchYoutubeTranscript(url: string) {
  const response = await axios.post(
    "https://youtube-transcript-data.replit.app/transcript",
    {
      url,
    }
  );
  const transcript = response.data;
  return transcript;
}

export async function createTranscriptDoc(
  transcript: any,
  metadata?: {
    title?: string;
    speaker?: string;
    channelName?: string;
    publishedAt?: string;
    videoId?: string; // Add videoId to the expected properties
    id?: string; // Also accept id as an alternative
    language?: string; // Accept language parameter from metadata
  }
): Promise<string> {
  try {
    // Get docs client
    const docsClient = await getGoogleDocsAuth();

    // Create document title (use video title or fallback to video ID)
    const videoId = transcript.video_id;
    const docTitle = metadata?.title
      ? `Transcript: ${metadata.title}`
      : `Transcript for Video ${videoId}`;

    // Create the document
    const createResponse = await docsClient.documents.create({
      requestBody: {
        title: docTitle,
      },
    });

    const documentId = createResponse.data.documentId;

    if (!documentId) {
      throw new Error("Failed to create Google Doc - no document ID returned");
    }

    // Prepare document content
    const requests = [];

    // Add document header with metadata if available
    if (metadata) {
      // Make sure videoId is properly set from either transcript object or metadata
      // Check all possible field name variations
      const videoIdFromMetadata = metadata.videoId || metadata.id || "";

      // Log available fields to debug
      console.log("Metadata fields available:", Object.keys(metadata));
      console.log("Transcript fields available:", Object.keys(transcript));

      // Try multiple possible sources for video ID
      // Use optional chaining to safely access properties that might not exist
      const safeVideoId =
        videoIdFromMetadata ||
        transcript.video_id ||
        (transcript as any).id ||
        videoId;

      console.log("Video ID options:", {
        videoIdFromMetadata,
        transcriptVideoId: transcript.video_id,
        transcriptId: (transcript as any).id, // Using type assertion for safety
        videoId,
      });

      console.log(`Using video ID for Google Doc: ${safeVideoId}`);

      const headerFields = [
        { label: "Video title: ", value: metadata.title || "N/A" },
        // Removed Speaker line as requested
        { label: "Channel: ", value: metadata.channelName || "N/A" },
        { label: "Published: ", value: metadata.publishedAt || "N/A" },
        { label: "Video ID: ", value: safeVideoId },
        {
          label: "Youtube link: ",
          value: `https://www.youtube.com/watch?v=${safeVideoId}`,
        },
        // Removed Language line as requested
      ];

      // Create the header text
      const headerText =
        headerFields
          .map((field) => `${field.label}${field.value || ""}`)
          .join("\n") + "\n\n--- TRANSCRIPT ---\n\n";

      // Insert the text
      requests.push({
        insertText: {
          location: {
            index: 1,
          },
          text: headerText,
        },
      });

      // Bold only the header labels, not the values
      let currentIndex = 1; // Start from position 1
      for (const field of headerFields) {
        const labelLength = field.label.length;
        const fieldValue = field.value || "";
        const lineLength = field.label.length + fieldValue.length + 1; // +1 for newline

        // Bold just the label part (e.g., "Video title: ")
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: currentIndex,
              endIndex: currentIndex + labelLength,
            },
            textStyle: {
              bold: true,
              foregroundColor: {
                color: {
                  rgbColor: {
                    blue: 0.2,
                    red: 0.2,
                    green: 0.2,
                  },
                },
              },
            },
            fields: "bold,foregroundColor",
          },
        });

        // Move index to next line
        currentIndex += lineLength;
      }

      // Calculate position of transcript heading
      const headerLength = headerFields
        .map((field) => `${field.label}${field.value || ""}`)
        .join("\n").length;
      const transcriptStartIndex = 1 + headerLength + 2; // +2 for double newline

      // Style transcript heading
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: transcriptStartIndex,
            endIndex: transcriptStartIndex + "--- TRANSCRIPT ---".length,
          },
          textStyle: {
            bold: true,
            underline: true,
            fontSize: {
              magnitude: 12,
              unit: "PT",
            },
            foregroundColor: {
              color: {
                rgbColor: {
                  blue: 0.4,
                  red: 0.2,
                  green: 0.2,
                },
              },
            },
          },
          fields: "bold,underline,fontSize,foregroundColor",
        },
      });
    }

    // Initialize startIndex - varies whether we've added a header
    let startIndex;

    if (metadata) {
      // Use the same video ID logic for consistency
      // Check all possible field name variations
      const videoIdFromMetadata = metadata.videoId || metadata.id || "";

      // Try multiple possible sources for video ID
      const safeVideoId =
        videoIdFromMetadata ||
        transcript.video_id ||
        (transcript as any).id ||
        videoId;

      const headerFields = [
        { label: "Video title: ", value: metadata.title || "N/A" },
        { label: "Channel: ", value: metadata.channelName || "N/A" },
        { label: "Published: ", value: metadata.publishedAt || "N/A" },
        { label: "Video ID: ", value: safeVideoId },
        {
          label: "Youtube link: ",
          value: `https://www.youtube.com/watch?v=${safeVideoId}`,
        },
        // Removed Language line as requested
      ];

      const headerLength = headerFields
        .map((field) => `${field.label}${field.value || ""}`)
        .join("\n").length;
      startIndex = 1 + headerLength + "\n\n--- TRANSCRIPT ---\n\n".length;
    } else {
      startIndex = 1;
    }

    // Add transcript content
    console.log(
      "Transcript structure for Google Doc:",
      JSON.stringify(transcript, null, 2)
    );

    // Check different possible transcript data structures
    const transcriptData =
      transcript.transcript_data || (transcript as any).Transcript_Data;

    if (transcriptData && transcriptData.length > 0) {
      console.log(
        `Found ${transcriptData.length} transcript segments to add to Google Doc`
      );

      for (const segment of transcriptData) {
        // Handle different property naming conventions using type assertions for flexibility
        const startTime = segment.start || (segment as any).Start || 0;
        const text = segment.text || (segment as any).Text || "";

        const timestamp = formatTimestamp(startTime);
        const segmentText = `[${timestamp}] ${text}\n`;

        console.log(
          `Adding segment: ${segmentText.substring(0, 50)}${
            segmentText.length > 50 ? "..." : ""
          }`
        );

        requests.push({
          insertText: {
            location: {
              index: startIndex,
            },
            text: segmentText,
          },
        });

        // Bold the timestamp
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: startIndex,
              endIndex: startIndex + timestamp.length + 2, // +2 for brackets
            },
            textStyle: {
              bold: true,
              foregroundColor: {
                color: {
                  rgbColor: {
                    blue: 0.5,
                    red: 0.0,
                    green: 0.0,
                  },
                },
              },
            },
            fields: "bold,foregroundColor",
          },
        });

        startIndex += segmentText.length;
      }
    } else {
      // If transcript_data is not an array or is empty, try to use Search_Doc_1 field which has formatted text
      const formattedTranscript =
        (transcript as any).search_doc_1 || (transcript as any).Search_Doc_1;

      if (formattedTranscript) {
        console.log("Using formatted transcript from Search_Doc_1 field");
        // Split by newlines to format properly
        const lines = formattedTranscript.split("\n");

        for (const line of lines) {
          if (line.trim()) {
            // Try to extract timestamp from the line (format: "0.00: Text")
            const match = line.match(/^(\d+\.\d+):\s*(.*)$/);

            if (match) {
              const timeInSeconds = parseFloat(match[1]);
              const text = match[2];

              const timestamp = formatTimestamp(timeInSeconds);
              const segmentText = `[${timestamp}] ${text}\n`;

              requests.push({
                insertText: {
                  location: {
                    index: startIndex,
                  },
                  text: segmentText,
                },
              });

              // Bold the timestamp
              requests.push({
                updateTextStyle: {
                  range: {
                    startIndex: startIndex,
                    endIndex: startIndex + timestamp.length + 2, // +2 for brackets
                  },
                  textStyle: {
                    bold: true,
                    foregroundColor: {
                      color: {
                        rgbColor: {
                          blue: 0.5,
                          red: 0.0,
                          green: 0.0,
                        },
                      },
                    },
                  },
                  fields: "bold,foregroundColor",
                },
              });

              startIndex += segmentText.length;
            } else {
              // Just add the line as is
              const plainText = `${line}\n`;

              requests.push({
                insertText: {
                  location: {
                    index: startIndex,
                  },
                  text: plainText,
                },
              });

              startIndex += plainText.length;
            }
          }
        }
      } else {
        // No transcript segments or formatted text found
        console.log("No transcript data found in any expected format");
        const noTranscriptText =
          "No transcript segments available for this video.";

        requests.push({
          insertText: {
            location: {
              index: startIndex,
            },
            text: noTranscriptText,
          },
        });

        // Style the no-transcript notice
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: startIndex,
              endIndex: startIndex + noTranscriptText.length,
            },
            textStyle: {
              italic: true,
              foregroundColor: {
                color: {
                  rgbColor: {
                    blue: 0.0,
                    red: 0.5,
                    green: 0.0,
                  },
                },
              },
            },
            fields: "italic,foregroundColor",
          },
        });
      }
    }

    // Apply all the changes
    await docsClient.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
      },
    });

    // Make the doc publicly readable
    try {
      const drive = google.drive({
        version: "v3",
        auth: (docsClient.context as any)._options.auth,
      });

      await drive.permissions.create({
        fileId: documentId,
        requestBody: {
          role: "reader",
          type: "anyone",
        },
      });
    } catch (permissionError) {
      console.error("Error setting document permissions:", permissionError);
      // Continue anyway since we have the doc
    }

    // Return the URL to the document
    return `https://docs.google.com/document/d/${documentId}/edit`;
  } catch (error) {
    console.error("Error creating transcript Google Doc:", error);
    throw error;
  }
}

export async function addToBigQuery(transcript: any, metadata: any) {
  // Initialize BigQuery client;
  const dataset = bigQuery.dataset("reptranscripts");
  const table = dataset.table("youtube_transcripts");
  const row = {
    ID: metadata.videoId,
    Language: transcript.language,
    Language_Code: transcript.language_code,
    Is_Generated: transcript.is_generated,
    Created_Time: new Date().toISOString(),
    Search_Doc_1: formatTranscriptAsText(transcript),
    Youtube_Link: metadata.cleanUrl,
    Video_Title: metadata.title,
    Video_Description: metadata.description,
    Channel_Name: metadata.channelName,
    Channel_Id: metadata.channelId,
    Published_Date: new Date(metadata.publishedAt).toISOString().split("T")[0],
    Video_Length: metadata.duration,
    View_Count: metadata.viewCount,
    User_Speakers: metadata.speaker,
    Extracted_Speakers: metadata.extractedNames,
    Speakers_Claude: metadata.speakersClaude || null,
    Speakers_GPT_Third: metadata.speakersGptThird || null,
    Transcript_Doc_Link: transcript.google_doc_url,
  };

  // Insert the row into BigQuery
  await table.insert(row, { ignoreUnknownValues: true });
  console.log("Successfully stored in BigQuery");
}

export async function addMetadataToSheet(
  metadata: any,
  googleDocUrl?: string
): Promise<
  sheets_v4.Schema$AppendValuesResponse | sheets_v4.Schema$UpdateValuesResponse
> {
  const spreadsheetId = "1fbwACJdwMoTHb5J-n9pg3DHqrkdMdB-2d0Q3e7_YHjc";
  try {
    const sheets = await getGoogleSheetsAuth();

    // Format data for Google Sheets
    const values = [
      [
        metadata.cleanUrl,
        metadata.videoId,
        metadata.title,
        metadata.speaker,
        metadata.channelName,
        metadata.channelId || "",
        metadata.publishedAt,
        metadata.duration || "",
        metadata.viewCount || "",
        metadata.description,
        metadata.extractedNames || "",
        googleDocUrl || "", // Add Google Doc URL as a new column
      ],
    ];

    // If the sheet doesn't exist yet, create it with headers
    try {
      // First check if the sheet exists and has headers
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "YouTubeMetadata!A1:L1", // Extended to L for GoogleDoc URL
      });

      // If no headers, add them
      if (!response.data.values || response.data.values.length === 0) {
        await addHeadersToSheet(sheets, spreadsheetId);
      }
    } catch (error) {
      // Sheet might not exist, try to create it
      await addHeadersToSheet(sheets, spreadsheetId);
    }

    // First, check if this video ID already exists in the sheet
    let existingRowIndex = -1;
    try {
      const allData = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "YouTubeMetadata!A:B", // Get all YouTube links and video IDs
      });

      if (allData.data.values && allData.data.values.length > 1) {
        // Start from index 1 to skip headers
        for (let i = 1; i < allData.data.values.length; i++) {
          const row = allData.data.values[i];
          // Check if video ID matches (column B)
          if (row.length > 1 && row[1] === metadata.videoId) {
            existingRowIndex = i + 1; // +1 because sheets are 1-indexed
            break;
          }
        }
      }
    } catch (error) {
      console.log("Error checking for existing entries:", error);
      // Continue with append if we can't check
    }

    // If found an existing entry, update it
    if (existingRowIndex > 0) {
      console.log(
        `Updating existing entry for video ID ${metadata.videoId} at row ${existingRowIndex}`
      );
      const updateRange = `YouTubeMetadata!A${existingRowIndex}:L${existingRowIndex}`;

      const result = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: updateRange,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values,
        },
      });

      return result.data;
    }
    // Otherwise, append as a new row
    else {
      console.log(`Adding new entry for video ID ${metadata.videoId}`);
      const result = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "YouTubeMetadata!A2:L", // Extended to L for GoogleDoc URL
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values,
        },
      });

      return result.data;
    }
  } catch (error) {
    console.error("Error adding metadata to Google Sheet:", error);
    throw error;
  }
}
