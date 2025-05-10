
import { BigQuery } from "@google-cloud/bigquery";

const credentials = JSON.parse(
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}"
);

export const bigQuery = new BigQuery({
  credentials,
  projectId: credentials.project_id,
});

export async function fetchVideoMeta(videoId: string) {
  try {
    const query = `
      SELECT
        video_id,
        title,
        channel_name,
        upload_date,
        published_at,
        url
      FROM 
        \`your_dataset.videos\`
      WHERE
        video_id = @videoId
      LIMIT 1
    `;

    const options = {
      query,
      params: { videoId },
    };

    const [rows] = await bigQuery.query(options);
    
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    return null;
  }
}
