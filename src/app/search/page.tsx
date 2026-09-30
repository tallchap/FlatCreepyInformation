import { App } from "@/components/search";
import { PrefaceDialog } from "@/components/search/preface-dialog";

export default function SearchPage() {
  return (
    <section className="container mx-auto max-w-6xl flex flex-col gap-4">
      <div className="flex justify-end">
        <PrefaceDialog />
      </div>
      <App />
    </section>
  );
}
