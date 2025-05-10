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
        Youtube_Link as url,
        Video_Length as video_length,
        Extracted_Speakers as speakers
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
    
    // Simply return the raw result without any date conversion
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    return null;
  }
}

/** Return [{start: seconds, text: "word…"}] sorted by time */
export async function fetchTranscript(id: string) {
  try {
    const [rows] = await bigQuery.query({
      query: `
        SELECT
          Timestamp_Seconds AS start,
          Word             AS text
        FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
        WHERE ID = @id
        ORDER BY start
      `,
      params: { id },
    });
    return rows as { start: number; text: string }[];
  } catch (error) {
    console.error("Error fetching transcript:", error);
    return [];
  }
}