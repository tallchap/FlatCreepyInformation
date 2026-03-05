export const BQ_PROJECT = "youtubetranscripts-429803";
export const BQ_DATASET = "reptranscripts";

export const TABLES = {
  legacyTranscripts: `${BQ_PROJECT}.${BQ_DATASET}.youtube_transcripts`,
  videos: `${BQ_PROJECT}.${BQ_DATASET}.youtube_videos`,
  transcriptSegments: `${BQ_PROJECT}.${BQ_DATASET}.youtube_transcript_segments`,
} as const;

export const TABLE_REFS = {
  legacyTranscripts: `\`${TABLES.legacyTranscripts}\``,
  videos: `\`${TABLES.videos}\``,
  transcriptSegments: `\`${TABLES.transcriptSegments}\``,
} as const;

export function useNewTranscriptTables() {
  return process.env.TRANSCRIPTS_USE_NEW_TABLES !== "false";
}

export function enableTranscriptDualWrite() {
  return process.env.TRANSCRIPTS_DUAL_WRITE === "true";
}
