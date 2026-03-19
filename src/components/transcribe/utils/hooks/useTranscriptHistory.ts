import { useLocalStorage } from "usehooks-ts";

export type TranscriptItem = {
  id: string;
  videoTitle?: string;
  youtubeLink?: string;
  googleDocUrl?: string;
  status: "success" | "failed" | "vectorizing";
  failedStep?: string;
  errorMessage?: string;
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

  // Update an existing transcript entry
  const updateTranscript = (
    id: string,
    updates: Partial<Omit<TranscriptItem, "id" | "uploadedAt">>
  ) => {
    setTranscriptHistory((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...updates } : item))
    );
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
    updateTranscript,
    removeTranscript,
    clearHistory,
  };
}
