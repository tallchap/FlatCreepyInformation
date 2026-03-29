import { config } from "dotenv";
import { BigQuery } from "@google-cloud/bigquery";

config({ path: ".env.local" });

const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
let credentials;
try { credentials = JSON.parse(credJson); } catch {
  const fixed = credJson.replace(
    /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
    (_m, key) => `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
  );
  credentials = JSON.parse(fixed);
}

const bigquery = new BigQuery({ credentials, projectId: credentials.project_id });
const DATASET = "reptranscripts";

async function createTables() {
  console.log("Creating research_runs table...");
  await bigquery.query({
    query: `
      CREATE TABLE IF NOT EXISTS \`${credentials.project_id}.${DATASET}.research_runs\` (
        run_id STRING NOT NULL,
        speaker STRING NOT NULL,
        date_after STRING,
        date_before STRING,
        query_variants ARRAY<STRING>,
        total_raw INT64,
        total_after_dedup INT64,
        total_scored INT64,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
      )
    `,
  });
  console.log("  -> research_runs created.");

  console.log("Creating research_candidates table...");
  await bigquery.query({
    query: `
      CREATE TABLE IF NOT EXISTS \`${credentials.project_id}.${DATASET}.research_candidates\` (
        run_id STRING NOT NULL,
        video_id STRING NOT NULL,
        title STRING,
        channel STRING,
        channel_id STRING,
        duration_seconds INT64,
        published_at STRING,
        description STRING,
        thumbnail_url STRING,
        confidence INT64,
        reasoning STRING,
        red_flags ARRAY<STRING>,
        category STRING,
        status STRING DEFAULT 'pending',
        reject_reason STRING,
        rule_generated STRING,
        vetted_at TIMESTAMP,
        processing_status STRING,
        processing_error STRING,
        processed_at TIMESTAMP,
        matched_rules ARRAY<STRING>,
        source STRING DEFAULT 'api_search',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
      )
    `,
  });
  console.log("  -> research_candidates created.");

  console.log("\nDone! Both tables created in", `${credentials.project_id}.${DATASET}`);
}

createTables().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
