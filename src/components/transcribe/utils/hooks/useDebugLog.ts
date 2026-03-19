import { useLocalStorage } from "usehooks-ts";

export interface DebugEntry {
  id: string;
  timestamp: string;
  step: string;
  status: "info" | "success" | "error";
  message: string;
  videoTitle?: string;
}

const MAX_ENTRIES = 50;

export function useDebugLog() {
  const [entries, setEntries] = useLocalStorage<DebugEntry[]>(
    "transcribe-debug-log",
    []
  );

  const addEntry = (entry: Omit<DebugEntry, "id" | "timestamp">) => {
    const newEntry: DebugEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    setEntries((prev) => [newEntry, ...prev].slice(0, MAX_ENTRIES));
  };

  const clearLog = () => setEntries([]);

  return { entries, addEntry, clearLog };
}
