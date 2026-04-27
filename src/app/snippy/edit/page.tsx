"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { SnippyEditor } from "@/components/snippy/snippy-editor";

function EditContent() {
  const params = useSearchParams();
  const videoGuid = params.get("video") || "";
  const inSec = parseFloat(params.get("in") || "0");
  const outSec = parseFloat(params.get("out") || "0");

  if (!videoGuid || outSec <= inSec) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <h2>No clip selected</h2>
        <p style={{ color: "#888", marginTop: 8 }}>
          Go back to <a href="/snippy" style={{ color: "#D97757" }}>clip selection</a> to pick a clip first.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ padding: "8px 24px", fontSize: 12, color: "#888" }}>
        <a href="/snippy" style={{ color: "#D97757", textDecoration: "none" }}>← Back to clip selection</a>
      </div>
      <SnippyEditor
        clipVideoGuid={videoGuid}
        clipInSec={inSec}
        clipOutSec={outSec}
        autoTranscribe
        hideMarks
      />
    </div>
  );
}

export default function SnippyEditPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "#888" }}>Loading editor...</div>}>
      <EditContent />
    </Suspense>
  );
}
