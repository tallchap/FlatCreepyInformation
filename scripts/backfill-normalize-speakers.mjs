/**
 * Backfill script: normalize known speaker name misspellings in BigQuery.
 *
 * For each entry in CANONICAL_MAP, finds rows where Speakers_GPT_Third or
 * Speakers_Claude contain the misspelling and replaces it with the canonical
 * form. This is a one-time data fix for existing rows; the app-level
 * canonicalization in Pass 3 handles future writes.
 *
 * Usage:  node scripts/backfill-normalize-speakers.mjs [--dry-run]
 */
import { BigQuery } from "@google-cloud/bigquery";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function parseServiceAccount(raw = "") {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const fixed = raw.replace(
      /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
      (_m, key) =>
        `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
    );
    return JSON.parse(fixed);
  }
}

const credentials = parseServiceAccount(
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "",
);
const bigQuery = new BigQuery({
  credentials,
  projectId: credentials.project_id,
});

const TABLE =
  "`youtubetranscripts-429803.reptranscripts.youtube_transcripts`";

const dryRun = process.argv.includes("--dry-run");

/**
 * Canonical map: keys are misspellings (exact, case-sensitive as stored),
 * values are the canonical form. Add new entries as needed.
 */
const CANONICAL_MAP = [
  { from: "Yann Le Cun", to: "Yann LeCun" },
  { from: "Yann Le Cunn", to: "Yann LeCun" },
  { from: "Yann Lecun", to: "Yann LeCun" },
];

const COLUMNS = ["Speakers_GPT_Third", "Speakers_Claude"];

let totalUpdated = 0;

for (const { from, to } of CANONICAL_MAP) {
  for (const col of COLUMNS) {
    // Find rows that contain this misspelling in this column
    const [countRows] = await bigQuery.query({
      query: `
        SELECT COUNT(*) AS cnt
        FROM ${TABLE}
        WHERE ${col} IS NOT NULL
          AND ${col} LIKE @pattern
      `,
      params: { pattern: `%${from}%` },
    });

    const count = Number(countRows[0]?.cnt ?? 0);
    if (count === 0) {
      console.log(`SKIP  "${from}" in ${col}: 0 rows`);
      continue;
    }

    console.log(
      `${dryRun ? "DRY-RUN" : "UPDATE"}  "${from}" => "${to}" in ${col}: ${count} rows`,
    );

    if (!dryRun) {
      await bigQuery.query({
        query: `
          UPDATE ${TABLE}
          SET ${col} = REPLACE(${col}, @fromName, @toName)
          WHERE ${col} IS NOT NULL
            AND ${col} LIKE @pattern
        `,
        params: { fromName: from, toName: to, pattern: `%${from}%` },
      });
      totalUpdated += count;
      console.log(`  => done (${count} rows updated)`);
    }
  }
}

console.log(
  dryRun
    ? "DRY-RUN complete. Re-run without --dry-run to apply changes."
    : `DONE. Total rows updated: ${totalUpdated}`,
);
