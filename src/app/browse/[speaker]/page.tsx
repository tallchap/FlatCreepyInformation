import { Suspense } from "react";
import { SpeakerVideosContainer } from "@/components/browse/speaker-videos";

export default async function SpeakerPage({
  params,
}: {
  params: Promise<{ speaker: string }>;
}) {
  const { speaker } = await params;
  const decodedSpeaker = decodeURIComponent(speaker);

  return (
    <section className="container mx-auto max-w-6xl flex flex-col gap-4">
      <Suspense fallback={<div className="text-center py-8 text-gray-500">Loading videos...</div>}>
        <SpeakerVideosContainer speaker={decodedSpeaker} />
      </Suspense>
    </section>
  );
}
