export type Clip = {
  clipId: string;
  videoId: string;
  title: string;
  category: "viral" | "ai_safety";
  durationMs: number;
  viralScore: number | null;
  viralReason: string | null;
  transcript: string | null;
  speaker: string | null;
  gcsUrl: string;
  vizardEditorUrl: string | null;
};

/** Raw clip from Vizard API response */
export type VizardClip = {
  videoId: number;
  videoUrl: string;
  videoMsDuration: number;
  title: string;
  transcript: string;
  viralScore: string;
  viralReason: string;
  relatedTopic: string;
  clipEditorUrl: string;
  disliked?: boolean;
  starred?: boolean;
};

export type VizardResponse = {
  code: number;
  shareLink?: string;
  videos: VizardClip[];
  projectId: number;
  projectName?: string;
  creditsUsed?: number;
};
