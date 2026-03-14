export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { fetchVideoMeta } from "@/lib/bigquery";
import { notFound } from "next/navigation";
import { VizardCurator } from "@/components/vizard/vizard-curator";

export default async function VizardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[\w-]{11}$/.test(id)) notFound();

  const videoMeta = await fetchVideoMeta(id);
  if (!videoMeta) notFound();

  // Try to load cached Vizard responses
  let generalClips = null;
  let safetyClips = null;
  try {
    generalClips = (await import(`@/data/vizard-${id}-general.json`)).default;
  } catch {}
  try {
    safetyClips = (await import(`@/data/vizard-${id}-safety.json`)).default;
  } catch {}

  return (
    <main className="p-4 max-w-7xl mx-auto">
      <VizardCurator
        videoId={id}
        videoMeta={{
          title: videoMeta.title,
          channel: videoMeta.channel,
          published: String(
            typeof videoMeta.published === "object" &&
              (videoMeta.published as any).value
              ? (videoMeta.published as any).value
              : videoMeta.published
          ),
          videoLength: videoMeta.video_length || null,
          speakers: videoMeta.speakers || null,
        }}
        generalResponse={generalClips}
        safetyResponse={safetyClips}
      />
    </main>
  );
}
