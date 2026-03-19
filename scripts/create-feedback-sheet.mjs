import { google } from "googleapis";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
const envContent = readFileSync(envPath, "utf8");

// Extract the JSON credentials from .env.local
const match = envContent.match(/GOOGLE_APPLICATION_CREDENTIALS_JSON="({[\s\S]*?})"/);
if (!match) throw new Error("Could not find GOOGLE_APPLICATION_CREDENTIALS_JSON in .env.local");
const credentials = JSON.parse(match[1]);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ],
});

const sheets = google.sheets({ version: "v4", auth });
const drive = google.drive({ version: "v3", auth });

// Create spreadsheet with header row
const res = await sheets.spreadsheets.create({
  requestBody: {
    properties: { title: "Snippysaurus Feedback" },
    sheets: [
      {
        properties: { title: "Sheet1" },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [
              {
                values: [
                  "Timestamp",
                  "Page URL",
                  "Feedback",
                  "Email",
                  "Screenshot URL",
                  "User Agent",
                ].map((label) => ({
                  userEnteredValue: { stringValue: label },
                  userEnteredFormat: { textFormat: { bold: true } },
                })),
              },
            ],
          },
        ],
      },
    ],
  },
});

const spreadsheetId = res.data.spreadsheetId;
const url = res.data.spreadsheetUrl;

// Freeze the header row
const sheetId = res.data.sheets[0].properties.sheetId;
await sheets.spreadsheets.batchUpdate({
  spreadsheetId,
  requestBody: {
    requests: [
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
    ],
  },
});

// Make it editable by anyone with the link (so the service account can write)
await drive.permissions.create({
  fileId: spreadsheetId,
  requestBody: { role: "writer", type: "anyone" },
});

console.log("Created Google Sheet:");
console.log("  ID:", spreadsheetId);
console.log("  URL:", url);
console.log("\nAdd to .env.local:");
console.log(`  FEEDBACK_SHEET_ID="${spreadsheetId}"`);
