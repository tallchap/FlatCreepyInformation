export const runtime = "nodejs";
export const revalidate = 3600;

import { notFound } from "next/navigation";
import { fetchVideoMeta } from "@/lib/bigquery";
import { fetchVideoClips } from "@/lib/bigquery";
import { ClipsPage } from "@/components/clips/clips-page";

export default async function ClipsVideoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[\w-]{11}$/.test(id)) notFound();

  const videoMeta = await fetchVideoMeta(id);
  if (!videoMeta) notFound();

  const clips = await fetchVideoClips(id);

  return (
    <main className="p-4 max-w-7xl mx-auto">
      <ClipsPage
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
        clips={clips}
      />
    </main>
  );
}
