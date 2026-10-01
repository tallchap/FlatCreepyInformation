import { App } from "@/components/search";
import { PrefaceDialog } from "@/components/search/preface-dialog";

export default function SearchPage() {
  return (
    <div className="cream-surface">
      <section className="container mx-auto max-w-6xl flex flex-col gap-4">
        <header className="surface-head">
          <div>
            <h1>Search transcripts</h1>
            <p>Find the exact words across every indexed video.</p>
          </div>
          <PrefaceDialog />
        </header>
        <App />
      </section>
    </div>
  );
}
