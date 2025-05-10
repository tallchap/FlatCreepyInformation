
import { BigQuery } from "@google-cloud/bigquery";

// Create credentials from environment variables if available
const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON 
  ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) 
  : undefined;

// Create BigQuery client with proper authentication
export const bigQuery = new BigQuery({
  credentials,
  projectId: credentials?.project_id || "youtubetranscripts-429803"
});

/**
 * Fetch video metadata from BigQuery
 * Including title, channel name, published date, and YouTube URL
 */
export async function fetchVideoMeta(videoId: string) {
  try {
    const [rows] = await bigQuery.query({
      query: `
        SELECT
          title,
          channel_title     AS channel,
          published_at      AS published,
          CONCAT('https://youtu.be/', video_id) AS youtube_url
        FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
        WHERE video_id = @id
        LIMIT 1
      `,
      params: { id: videoId },
    });

    // Return the first result or undefined if nothing found
    return rows[0] as
      | { title: string; channel: string; published: string; youtube_url: string }
      | undefined;
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    return undefined;
  }
}
