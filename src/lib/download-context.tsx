"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type DownloadStatus = "downloading" | "complete" | "error";

export type DownloadItem = {
  id: string;
  videoId: string;
  title: string;
  startSec: number;
  endSec: number;
  quality: string;
  status: DownloadStatus;
  progress: number;
  error?: string;
  date: string;
};

export type StartDownloadParams = {
  videoId: string;
  title: string;
  startSec: number;
  endSec: number;
  quality: string;
};

type DownloadContextType = {
  downloads: DownloadItem[];
  startDownload: (params: StartDownloadParams) => void;
  dismissDownload: (id: string) => void;
  clearCompleted: () => void;
  hasActive: boolean;
};

const DownloadContext = createContext<DownloadContextType | null>(null);

const STORAGE_KEY = "clip-downloads";
const MAX_ITEMS = 20;

function loadFromStorage(): DownloadItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items: DownloadItem[] = JSON.parse(raw);
    // Reset any stale "downloading" items from a previous session
    return items.map((d) =>
      d.status === "downloading" ? { ...d, status: "error" as const, error: "Interrupted", progress: 0 } : d,
    );
  } catch {
    return [];
  }
}

function saveToStorage(items: DownloadItem[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const downloadsRef = useRef(downloads);
  downloadsRef.current = downloads;

  // Load from localStorage on mount
  useEffect(() => {
    setDownloads(loadFromStorage());
  }, []);

  // Persist to localStorage on change
  useEffect(() => {
    if (downloads.length > 0) saveToStorage(downloads);
  }, [downloads]);

  const updateItem = useCallback((id: string, patch: Partial<DownloadItem>) => {
    setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);

  const startDownload = useCallback(
    (params: StartDownloadParams) => {
      const id = crypto.randomUUID();
      const item: DownloadItem = {
        id,
        videoId: params.videoId,
        title: params.title,
        startSec: params.startSec,
        endSec: params.endSec,
        quality: params.quality,
        status: "downloading",
        progress: 0,
        date: new Date().toISOString(),
      };

      setDownloads((prev) => [item, ...prev].slice(0, MAX_ITEMS));

      // Fake progress animation based on clip length
      const clipDuration = params.endSec - params.startSec;
      // Estimate: ~2s per second of clip for download+trim, cap at 120s
      const estimatedMs = Math.min(clipDuration * 2000, 120000);
      const progressInterval = setInterval(() => {
        setDownloads((prev) => {
          const d = prev.find((x) => x.id === id);
          if (!d || d.status !== "downloading") {
            clearInterval(progressInterval);
            return prev;
          }
          // Ease toward 90%
          const newProgress = d.progress + (90 - d.progress) * 0.05;
          return prev.map((x) => (x.id === id ? { ...x, progress: Math.min(90, newProgress) } : x));
        });
      }, estimatedMs / 50);

      // Do the actual fetch
      (async () => {
        try {
          const resp = await fetch("/api/clip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: `https://www.youtube.com/watch?v=${params.videoId}`,
              startSec: params.startSec,
              endSec: params.endSec,
              quality: params.quality,
            }),
          });

          clearInterval(progressInterval);

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: "Export failed" }));
            updateItem(id, { status: "error", error: err.error || "Export failed", progress: 0 });
            return;
          }

          const blob = await resp.blob();
          updateItem(id, { status: "complete", progress: 100 });

          // Trigger browser download
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `clip-${params.videoId}-${Math.round(params.startSec)}-${Math.round(params.endSec)}.mp4`;
          a.click();
          URL.revokeObjectURL(a.href);
        } catch (err: any) {
          clearInterval(progressInterval);
          updateItem(id, { status: "error", error: err.message || "Network error", progress: 0 });
        }
      })();
    },
    [updateItem],
  );

  const dismissDownload = useCallback((id: string) => {
    setDownloads((prev) => {
      const next = prev.filter((d) => d.id !== id);
      saveToStorage(next);
      return next;
    });
  }, []);

  const clearCompleted = useCallback(() => {
    setDownloads((prev) => {
      const next = prev.filter((d) => d.status === "downloading");
      saveToStorage(next);
      return next;
    });
  }, []);

  const hasActive = downloads.some((d) => d.status === "downloading");

  return (
    <DownloadContext.Provider value={{ downloads, startDownload, dismissDownload, clearCompleted, hasActive }}>
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownload() {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error("useDownload must be used within DownloadProvider");
  return ctx;
}
