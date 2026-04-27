import { Suspense } from "react";
import { SnippyClipSelector } from "@/components/snippy/snippy-clip-selector";

export default function SnippyPage() {
  return (
    <div className="snippy-theme min-h-screen">
      <div className="max-w-[1100px] mx-auto px-6 py-6">
        <Suspense>
          <SnippyClipSelector />
        </Suspense>
      </div>
    </div>
  );
}
