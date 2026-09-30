export type Speaker = {
  name: string;
  videoCount: number;
  updatedAt?: string | null;
};

export type YearEntry = {
  year: number;
  videoCount: number;
};

export type MonthEntry = {
  month: number;
  videoCount: number;
};

export type BrowseVideo = {
  id: string;
  title: string;
  channel: string;
  published: string;
  speakers: string;
  youtubeUrl: string;
  videoLength: string | null;
};

export type BrowseSnippet = {
  id: string;
  videoId: string;
  title: string;
  durationMs: number;
  url: string;
  transcript: string | null;
};

export type SpeakerLibrary = {
  videos: BrowseVideo[];
  snippets: BrowseSnippet[];
};
