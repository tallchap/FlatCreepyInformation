"use client";

import { DownloadProvider } from "@/lib/download-context";
import { DownloadPanel } from "@/components/download-panel";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <DownloadProvider>
      {children}
      <DownloadPanel />
    </DownloadProvider>
  );
}
