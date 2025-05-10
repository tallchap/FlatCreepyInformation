
import { BigQuery } from "@google-cloud/bigquery";

// Share a single client between hot-reloads during `next dev`
// Use explicit credentials if available, fallback to application default
const bigquery =
  (global as any).bigquery ??
  new BigQuery({ 
    projectId: "youtubetranscripts-429803",
    // This will use credentials from environment variables if available
    // or fall back to application default credentials
  });

if (process.env.NODE_ENV !== "production") (global as any).bigquery = bigquery;

/**
 * Fetch title, channel, published date, and the canonical YouTube URL
 * for a single video from
 *   youtubetranscripts-429803.reptranscripts.youtube_transcripts
 */
export async function fetchVideoMeta(videoId: string) {
  const [rows] = await bigquery.query({
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

  // returns undefined if nothing found
  return rows[0] as
    | { title: string; channel: string; published: string; youtube_url: string }
    | undefined;
}
