export type Clip = {
  clipId: string;
  videoId: string;
  title: string;
  category: "viral" | "ai_safety" | "contemplative" | "mainstream";
  durationMs: number;
  viralScore: number | null;
  viralReason: string | null;
  transcript: string | null;
  speaker: string | null;
  gcsUrl: string;
  vizardEditorUrl: string | null;
  persona: string | null;
};

export type AutoSnippet = {
  snippetId: string;
  originalVideoId: string;
  title: string;
  description: string | null;
  category: "viral" | "ai_safety" | "contemplative" | "mainstream";
  durationMs: number;
  transcript: string | null;
  gcsUrl: string;
  provider: string | null;
  speaker: string | null;
  createdAt: string | null;
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
