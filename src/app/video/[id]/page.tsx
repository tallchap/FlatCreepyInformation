export const runtime = "nodejs";
export const revalidate = 3600;

import { notFound } from "next/navigation";
import { fetchVideoMeta } from "@/lib/bigquery";
import TranscriptPane from "@/components/TranscriptPane";

/** 🔹 tiny util: "1h2m3s" → 3723  •  "90" → 90  •  "816.76" → 816 */
function toSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.floor(parseFloat(raw));

  const re = /(\d+h)?(\d+m)?(\d+s)?/;
  const [, h, m, s] = raw.match(re) || [];
  return (
    (h ? parseInt(h) * 3600 : 0) +
      (m ? parseInt(m) * 60 : 0) +
      (s ? parseInt(s) : 0) || null
  );
}

export default async function VideoPage({
  params,
  searchParams, // ⬅️  comes from Next 15
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;

  const { id } = resolvedParams;
  if (!/^[\w-]{11}$/.test(id)) notFound();

  const videoMeta = await fetchVideoMeta(id);
  if (!videoMeta) notFound();

  // Parse "t" (or "start") from the URL
  const startSec = toSeconds(resolvedSearchParams.t) ?? null;

  /* ----------- RENDER ---------- */
  return (
    <main className="flex flex-col min-h-screen items-center p-4 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-4 w-full max-w-4xl">
        {videoMeta.title}
      </h1>

      <div className="w-full max-w-4xl aspect-video mb-3">
        <iframe
          id={`player-${id}`}
          className="w-full h-full rounded-xl shadow-lg"
          src={`https://www.youtube.com/embed/${id}${
            startSec !== null
              ? `?start=${startSec}&autoplay=1&enablejsapi=1`
              : `?enablejsapi=1`
          }`}
          title={videoMeta.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>

      <div className="w-full max-w-4xl bg-white dark:bg-gray-800 rounded-xl shadow-md p-3 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-1 gap-1 mb-1">
          <div>
            <h2 className="text-sm text-gray-500 dark:text-gray-400">
              Channel
            </h2>
            <p className="font-medium">{videoMeta.channel}</p>
          </div>

          <div>
            <h2 className="text-sm text-gray-500 dark:text-gray-400">
              Published
            </h2>
            <p className="font-medium">
              {videoMeta.published
                ? typeof videoMeta.published === "object" &&
                  (videoMeta.published as any).value
                  ? (videoMeta.published as any).value
                  : String(videoMeta.published)
                : "Date not available"}
            </p>
          </div>

          <div>
            <h2 className="text-sm text-gray-500 dark:text-gray-400">
              Video Length
            </h2>
            <p className="font-medium">
              {videoMeta.video_length || "Not available"}
            </p>
          </div>

          <div>
            <h2 className="text-sm text-gray-500 dark:text-gray-400">
              Speakers
            </h2>
            <p className="font-medium">{videoMeta.speakers || "Not listed"}</p>
          </div>
        </div>
      </div>

      <div className="w-full max-w-4xl mb-4">
        <a
          href={`/edit?v=${id}`}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors"
          style={{ backgroundColor: "#DC2626" }}
        >
          Clip Video
        </a>
      </div>

      <TranscriptPane videoId={id} height={200} initialTimestamp={startSec} />
    </main>
  );
}
