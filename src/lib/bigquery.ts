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
        ID as video_id,
        Video_Title as title,
        Channel_Name as channel_name,
        Published_Date as published_at,
        Youtube_Link as url
      FROM 
        \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
      WHERE
        ID = @videoId
      LIMIT 1
    `;

    const options = {
      query,
      params: { videoId },
    };

    const [rows] = await bigQuery.query(options);

    if (!rows?.length) return null;

    const result = rows[0];

    // Format date if it exists and is valid
    if (result.published_at) {
      const dateValue = new Date(result.published_at);
      if (!isNaN(dateValue.getTime())) {
        result.published_at = dateValue.toISOString();
      }
    }

    return result;
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    return null;
  }
}