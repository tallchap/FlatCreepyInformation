import { SnippyEditor } from "@/components/snippy/snippy-editor";

export default function SnippyPage() {
  return (
    <div className="snippy-theme min-h-screen">
      <div className="max-w-[1600px] mx-auto px-6 py-6">
        <SnippyEditor />
      </div>
    </div>
  );
}
