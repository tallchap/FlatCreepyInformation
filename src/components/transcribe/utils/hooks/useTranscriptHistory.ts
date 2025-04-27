import { useLocalStorage } from "usehooks-ts";

export type TranscriptItem = {
  id: string;
  videoTitle?: string;
  youtubeLink?: string;
  googleDocUrl?: string;
  status: "success" | "failed";
  uploadedAt: string;
};

export function useTranscriptHistory() {
  const [transcriptHistory, setTranscriptHistory] = useLocalStorage<
    TranscriptItem[]
  >("transcript-history", []);

  // Add a new transcript to history
  const addTranscript = (
    transcript: Omit<TranscriptItem, "id" | "uploadedAt">
  ) => {
    const newItem: TranscriptItem = {
      ...transcript,
      id: crypto.randomUUID(), // Generate a unique ID
      uploadedAt: new Date().toISOString(),
    };

    setTranscriptHistory((prev) => [newItem, ...prev]);
    return newItem;
  };

  // Remove a transcript from history
  const removeTranscript = (id: string) => {
    setTranscriptHistory((prev) => prev.filter((item) => item.id !== id));
  };

  // Clear all history
  const clearHistory = () => {
    setTranscriptHistory([]);
  };

  return {
    transcriptHistory,
    addTranscript,
    removeTranscript,
    clearHistory,
  };
}
