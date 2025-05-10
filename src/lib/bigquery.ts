import { BigQuery } from "@google-cloud/bigquery";

const credentials = JSON.parse(
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}"
);

export const bigQuery = new BigQuery({
  credentials,
  projectId: credentials.project_id,
});
