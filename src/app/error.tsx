"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    // Fire-and-forget: also surface this crash in /admin/log so we can see
    // what threw next time the page-level error boundary renders.
    fetch("/api/admin/log-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: "page-crash",
        step: "page-crash",
        status: "error",
        detail: {
          message: error?.message || String(error),
          digest: error?.digest || null,
          path: typeof window !== "undefined" ? window.location.pathname : null,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        },
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <div style={{ padding: 40, fontFamily: "system-ui", maxWidth: 800, margin: "0 auto" }}>
      <h2>Something went wrong!</h2>
      <p style={{ color: "#6b7280" }}>The page hit an unexpected error. It's been logged.</p>
      {error?.message && (
        <pre style={{ background: "#f3f4f6", padding: 12, borderRadius: 6, fontSize: 12, whiteSpace: "pre-wrap", overflowX: "auto" }}>
          {error.message}
        </pre>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={() => reset()} style={{ padding: "6px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "white", cursor: "pointer" }}>
          Try again
        </button>
        <a href="/transcribe" style={{ padding: "6px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "white", textDecoration: "none", color: "#111827" }}>
          Back to Transcribe
        </a>
      </div>
    </div>
  );
}
