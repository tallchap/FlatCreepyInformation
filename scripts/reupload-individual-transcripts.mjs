#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  Re-upload transcripts as INDIVIDUAL files per video
//  (one file per video instead of one giant file per speaker)
//  This ensures the model always sees the video ID in context.
// ─────────────────────────────────────────────────────────────
import { BigQuery } from "@google-cloud/bigquery";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
const bigquery = new BigQuery({
  projectId: creds.project_id,
  credentials: creds,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SPEAKERS = [
  {
    name: "Eliezer Yudkowsky",
    slug: "yudkowsky",
    assistantId: "asst_ZSrgyWlmv4RLQrj1Cyiyn8ob",
  },
  {
    name: "Liron Shapira",
    slug: "shapira",
    assistantId: "asst_BGgQsWk21FqaSCzKRIqJVeS0",
  },
];

const SPEAKERS_EXPR = `COALESCE(NULLIF(Speakers_GPT_Third, ''), Speakers_Claude)`;

async function fetchSpeakerTranscripts(speakerName) {
  const [rows] = await bigquery.query({
    query: `
      SELECT DISTINCT
        t.ID,
        t.Video_Title,
        t.Published_Date,
        t.Search_Doc_1
      FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\` t,
      UNNEST(SPLIT(${SPEAKERS_EXPR}, ',')) AS s
      WHERE TRIM(s) = @speaker
        AND t.Search_Doc_1 IS NOT NULL
        AND LENGTH(TRIM(t.Search_Doc_1)) > 100
      ORDER BY t.Published_Date DESC
    `,
    params: { speaker: speakerName },
  });
  return rows;
}

async function uploadFileToOpenAI(videoId, title, date, transcript) {
  const content = `VIDEO_ID: ${videoId}
Title: ${title}
Date: ${date || "Unknown"}
URL: https://youtu.be/${videoId}
─────────────────────────────────────
${transcript}
─────────────────────────────────────
END OF TRANSCRIPT — Video ID: ${videoId} — Title: ${title}`;

  // Write temp file
  const tmpPath = `/tmp/transcript_${videoId}.txt`;
  fs.writeFileSync(tmpPath, content);

  const file = await openai.files.create({
    file: fs.createReadStream(tmpPath),
    purpose: "assistants",
  });

  fs.unlinkSync(tmpPath);
  return file;
}

async function main() {
  const fileIdMapping = {}; // Maps openai_file_id -> { videoId, title }

  for (const speaker of SPEAKERS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing ${speaker.name}...`);
    console.log(`${"=".repeat(60)}`);

    // 1. Fetch transcripts
    const transcripts = await fetchSpeakerTranscripts(speaker.name);
    console.log(`Found ${transcripts.length} videos with transcripts`);

    // 2. Upload each as individual file
    const fileIds = [];
    const speakerMapping = {};

    for (let i = 0; i < transcripts.length; i++) {
      const t = transcripts[i];
      const dateStr = t.Published_Date
        ? new Date(t.Published_Date.value || t.Published_Date)
            .toISOString()
            .split("T")[0]
        : "Unknown";

      console.log(
        `  [${i + 1}/${transcripts.length}] Uploading: ${t.ID} - ${t.Video_Title?.substring(0, 60)}...`
      );

      try {
        const file = await uploadFileToOpenAI(
          t.ID,
          t.Video_Title,
          dateStr,
          t.Search_Doc_1
        );
        fileIds.push(file.id);
        speakerMapping[file.id] = {
          videoId: t.ID,
          title: t.Video_Title,
        };

        // Small delay to avoid rate limits
        if (i % 10 === 9) {
          console.log("  (pausing briefly to avoid rate limits...)");
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error(`  ERROR uploading ${t.ID}: ${err.message}`);
      }
    }

    console.log(`\nUploaded ${fileIds.length} files for ${speaker.name}`);

    // 3. Create new vector store
    console.log(`Creating vector store for ${speaker.name}...`);
    const vectorStore = await openai.vectorStores.create({
      name: `${speaker.name} - Individual Transcripts`,
    });
    console.log(`Vector store created: ${vectorStore.id}`);

    // 4. Add files to vector store in batches
    const batchSize = 50;
    for (let i = 0; i < fileIds.length; i += batchSize) {
      const batch = fileIds.slice(i, i + batchSize);
      console.log(
        `  Adding batch ${Math.floor(i / batchSize) + 1} (${batch.length} files)...`
      );
      await openai.vectorStores.fileBatches.createAndPoll(vectorStore.id, {
        file_ids: batch,
      });
    }

    console.log(`All files added to vector store ${vectorStore.id}`);

    // 5. Update assistant to use new vector store
    console.log(`Updating assistant ${speaker.assistantId}...`);
    await openai.beta.assistants.update(speaker.assistantId, {
      tool_resources: {
        file_search: {
          vector_store_ids: [vectorStore.id],
        },
      },
    });
    console.log(`Assistant updated to use new vector store`);

    // Save mapping for this speaker
    fileIdMapping[speaker.slug] = {
      vectorStoreId: vectorStore.id,
      files: speakerMapping,
    };
  }

  // 6. Save the complete file_id -> video_id mapping
  const mappingPath = path.join(
    process.cwd(),
    "src",
    "lib",
    "file-citation-map.json"
  );
  fs.writeFileSync(mappingPath, JSON.stringify(fileIdMapping, null, 2));
  console.log(`\nMapping saved to ${mappingPath}`);
  console.log("Done!");
}

main().catch(console.error);
