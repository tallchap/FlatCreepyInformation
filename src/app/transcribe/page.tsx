import { SingleForm } from "@/components/transcribe/single-form";
import { UploadHistoryTable } from "@/components/transcribe/upload-history";

export default function TranscribePage() {
  return (
    <section className="container mx-auto max-w-4xl flex flex-col gap-4">
      <SingleForm />
      <UploadHistoryTable />
    </section>
  );
}
