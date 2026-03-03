import { SingleForm } from "@/components/transcribe/single-form";
import { UploadHistoryTable } from "@/components/transcribe/upload-history";
import { FailedTranscriptsTable } from "@/components/transcribe/failed-transcripts-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function TranscribePage() {
  return (
    <section className="container mx-auto max-w-4xl flex flex-col gap-4">
      <SingleForm />
      <Tabs defaultValue="history" className="w-full">
        <TabsList>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="failed">Failed Pulls</TabsTrigger>
        </TabsList>
        <TabsContent value="history">
          <UploadHistoryTable />
        </TabsContent>
        <TabsContent value="failed">
          <FailedTranscriptsTable />
        </TabsContent>
      </Tabs>
    </section>
  );
}
