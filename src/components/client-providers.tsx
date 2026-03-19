"use client";

import { DownloadProvider } from "@/lib/download-context";
import { DownloadPanel } from "@/components/download-panel";
import { FeedbackWidget } from "@/components/feedback-widget";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <DownloadProvider>
      {children}
      <DownloadPanel />
      <FeedbackWidget />
    </DownloadProvider>
  );
}
