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
  stageDetail?: string;
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

  useEffect(() => {
    setDownloads(loadFromStorage());
  }, []);

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

      (async () => {
        try {
          // Step 1: Start the clip job — try GCS first, fall back to RapidAPI
          let startResp = await fetch("/api/clip-gcs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videoId: params.videoId,
              startSec: params.startSec,
              endSec: params.endSec,
              quality: params.quality,
            }),
          });

          let route = "gcs";
          if (!startResp.ok) {
            // GCS not available — fall back to RapidAPI
            route = "rapidapi";
            startResp = await fetch("/api/clip", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: `https://www.youtube.com/watch?v=${params.videoId}`,
                startSec: params.startSec,
                endSec: params.endSec,
                quality: params.quality,
              }),
            });
          }

          if (!startResp.ok) {
            const err = await startResp.json().catch(() => ({ error: "Export failed" }));
            updateItem(id, { status: "error", error: err.error || "Export failed", progress: 0 });
            return;
          }

          const { jobId } = await startResp.json();
          if (!jobId) {
            updateItem(id, { status: "error", error: "No job ID returned", progress: 0 });
            return;
          }

          updateItem(id, { progress: 5 });

          // Step 2: Poll for status — no hard timeout, backend controls lifecycle
          const pollInterval = 3000;
          let consecutiveErrors = 0;

          while (true) {
            await new Promise((r) => setTimeout(r, pollInterval));

            // Check if this download was dismissed
            const current = downloadsRef.current.find((d) => d.id === id);
            if (!current || current.status !== "downloading") return;

            let status;
            try {
              const statusResp = await fetch(`/api/clip-status?jobId=${jobId}`);
              if (!statusResp.ok) {
                consecutiveErrors++;
                fetch("/api/download-client-error", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ error: `HTTP ${statusResp.status}`, jobId, consecutiveErrors }),
                }).catch(() => {});
                if (consecutiveErrors >= 50) {
                  updateItem(id, { status: "error", error: "Lost connection to server", progress: 0 });
                  return;
                }
                continue;
              }
              consecutiveErrors = 0;
              status = await statusResp.json();
            } catch (pollErr: any) {
              consecutiveErrors++;
              fetch("/api/download-client-error", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: pollErr?.message || "Network error", jobId, consecutiveErrors }),
              }).catch(() => {});
              if (consecutiveErrors >= 50) {
                updateItem(id, { status: "error", error: "Lost connection to server", progress: 0 });
                return;
              }
              continue;
            }

            if (status.status === "ready") {
              updateItem(id, { progress: 95 });

              // Step 3: Download the clip file
              const fileResp = await fetch(`/api/clip-download?jobId=${jobId}`);
              if (!fileResp.ok) {
                const err = await fileResp.json().catch(() => ({ error: "Download failed" }));
                updateItem(id, { status: "error", error: err.error || "Download failed", progress: 0 });
                return;
              }

              const blob = await fileResp.blob();
              updateItem(id, { status: "complete", progress: 100 });

              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `clip-${params.videoId}-${Math.round(params.startSec)}-${Math.round(params.endSec)}.mp4`;
              a.click();
              URL.revokeObjectURL(a.href);
              return;
            }

            if (status.status === "failed") {
              updateItem(id, { status: "error", error: status.error || "Clip processing failed", progress: 0 });
              return;
            }

            // Update progress and stage from backend
            if (status.progress != null) {
              updateItem(id, {
                progress: Math.min(90, status.progress),
                stageDetail: status.stageDetail || undefined,
              });
            }
          }
        } catch (err: any) {
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
