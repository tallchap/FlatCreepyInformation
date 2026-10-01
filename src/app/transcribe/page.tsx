import { SingleForm } from "@/components/transcribe/single-form";
import { UploadHistoryTable } from "@/components/transcribe/upload-history";
import { DebugPanel } from "@/components/transcribe/debug-panel";

export default function TranscribePage() {
  return (
    <div className="cream-surface">
      <section className="container mx-auto max-w-4xl flex flex-col gap-4">
        <header className="surface-head">
          <div>
            <h1>Transcribe</h1>
            <p>Add a YouTube video to the searchable library.</p>
          </div>
        </header>
        <SingleForm />
        <UploadHistoryTable />
        <DebugPanel />
      </section>
    </div>
  );
}
