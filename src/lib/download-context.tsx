"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type DownloadStatus = "downloading" | "complete" | "error";

export type ClipSegment = { in: number; out: number };

export type DownloadItem = {
  id: string;
  videoId: string;
  title: string;
  startSec: number;
  endSec: number;
  segments?: ClipSegment[];
  quality: string;
  status: DownloadStatus;
  progress: number;
  error?: string;
  stageDetail?: string;
  source?: string; // which path the server used (bunny, rapidapi-prefix, ytdlp-sections, ...)
  elapsedSec?: number; // request → clip ready
  etaSec?: number; // server's estimate of seconds left, as of etaAt
  etaAt?: number; // ms timestamp the estimate was read
  firstEtaSec?: number; // the estimate shown when the export started
  startedAt?: number; // ms timestamp of the request
  date: string;
};

export type StartDownloadParams = {
  videoId: string;
  title: string;
  segments: ClipSegment[];
  quality: string;
  overlay?: unknown;
};

function slug(s: string) {
  return s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "clip";
}

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

// Wait `ms`, or less if the tab comes back into view: background tabs' timers
// are throttled, which left finished exports undownloaded for minutes.
function waitOrVisible(ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); document.removeEventListener("visibilitychange", onVis); resolve(); };
    const onVis = () => { if (document.visibilityState === "visible") done(); };
    const t = setTimeout(done, ms);
    document.addEventListener("visibilitychange", onVis);
  });
}

// The finished clip, with retries: network errors and 5xx are retried with
// backoff (1, 2, 4, 8 s); a 4xx (job expired or unknown) is final.
async function fetchClipFile(jobId: string): Promise<{ blob: Blob } | { error: string }> {
  let last = "Download failed";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const resp = await fetch(`/api/clip-download?jobId=${jobId}`);
      if (resp.ok) return { blob: await resp.blob() };
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      last = err.error || `HTTP ${resp.status}`;
      if (resp.status < 500) return { error: last };
    } catch (e: any) {
      last = e?.message || "Network error";
    }
    fetch("/api/download-client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `clip-download attempt ${attempt}: ${last}`, jobId }),
    }).catch(() => {});
    if (attempt < 5) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }
  return { error: last };
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
      const segs = params.segments;
      const t0 = Date.now();
      const item: DownloadItem = {
        id,
        videoId: params.videoId,
        title: params.title,
        startSec: segs[0].in,
        endSec: segs[segs.length - 1].out,
        segments: segs,
        quality: params.quality,
        status: "downloading",
        progress: 0,
        startedAt: t0,
        date: new Date().toISOString(),
      };

      setDownloads((prev) => [item, ...prev].slice(0, MAX_ITEMS));

      (async () => {
        try {
          // Step 1: Start the clip job. /api/clip picks the source: the Bunny
          // file for stored videos, YouTube on demand for yt-only ones.
          const startResp = await fetch("/api/clip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videoId: params.videoId,
              quality: params.quality,
              segments: segs,
              ...(params.overlay ? { overlay: params.overlay } : {}),
            }),
          });

          if (!startResp.ok) {
            const err = await startResp.json().catch(() => ({ error: "Export failed" }));
            updateItem(id, { status: "error", error: err.error || "Export failed", progress: 0 });
            return;
          }

          const started = await startResp.json();
          const { jobId } = started;
          if (typeof started.etaSec === "number") {
            updateItem(id, { etaSec: started.etaSec, etaAt: Date.now(), firstEtaSec: started.etaSec });
          }
          if (!jobId) {
            updateItem(id, { status: "error", error: "No job ID returned", progress: 0 });
            return;
          }

          updateItem(id, { progress: 5 });

          // Step 2: Poll for status — no hard timeout, backend controls lifecycle
          const pollInterval = 3000;
          let consecutiveErrors = 0;

          while (true) {
            await waitOrVisible(pollInterval);

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

              // Step 3: Download the clip file (retried: the job is done, a
              // dropped connection shouldn't lose the clip)
              const got = await fetchClipFile(jobId);
              if ("error" in got) {
                updateItem(id, { status: "error", error: got.error, progress: 0 });
                return;
              }
              const blob = got.blob;
              updateItem(id, { status: "complete", progress: 100, source: status.source || undefined, elapsedSec: (Date.now() - t0) / 1000 });

              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = segs.length > 1
                ? `${slug(params.title)}-clip.mp4`
                : `clip-${params.videoId}-${Math.round(segs[0].in)}-${Math.round(segs[0].out)}.mp4`;
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
                stageDetail: [status.stage, status.stageDetail].filter(Boolean).join(" — ") || undefined,
                source: status.source || undefined,
                elapsedSec: (Date.now() - t0) / 1000,
                ...(typeof status.etaSec === "number" ? { etaSec: status.etaSec, etaAt: Date.now() } : {}),
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
