import { Suspense } from "react";
import { SpeakerVideosContainer } from "@/components/browse/speaker-videos";

export default async function SpeakerPage({ params }: { params: Promise<{ speaker: string }> }) {
  const { speaker } = await params;
  let name = speaker;
  try { name = decodeURIComponent(speaker); } catch { /* Preserve literal percent signs in names. */ }
  return (
    <Suspense fallback={<p role="status">Loading speaker…</p>}>
      <SpeakerVideosContainer speaker={name} />
    </Suspense>
  );
}
