interface TranscriptSnippet {
  text: string;
  start: number;
  duration: number;
}

export interface Transcript {
  video_id: string;
  language: string;
  language_code: string;
  is_generated: boolean;
  fetched_at: string;
  transcript_data: TranscriptSnippet[];
  error?: string; // Error message if fetching failed
  proxy_info?: string; // Info about the proxy used for successful fetch
  proxy_errors?: string; // Detailed errors from all proxy attempts
  proxyAttempts?: number; // Number of proxy attempts made
  bigquery_status?: {
    stored: boolean;
    message?: string | null;
    datasetId?: string | null;
  };
}
