import { BulkForm } from "@/components/transcribe/bulk-form";
import { SingleForm } from "@/components/transcribe/single-form";
import { UploadHistoryTable } from "@/components/transcribe/upload-history";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function TranscribePage() {
  return (
    <section className="container mx-auto max-w-4xl flex flex-col gap-4">
      <Tabs defaultValue="single">
        <TabsList className="w-full">
          <TabsTrigger value="single">Metadata & Transcript</TabsTrigger>
          <TabsTrigger value="bulk">Bulk Upload</TabsTrigger>
        </TabsList>
        <TabsContent value="single">
          <SingleForm />
        </TabsContent>
        <TabsContent value="bulk">
          <BulkForm />
        </TabsContent>
      </Tabs>
      <UploadHistoryTable />
    </section>
  );
}
