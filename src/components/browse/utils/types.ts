export type Speaker = {
  name: string;
  videoCount: number;
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
