
export const runtime = "nodejs";
export const revalidate = 3600;

import { notFound } from "next/navigation";
import { fetchVideoMeta } from "@/lib/bigquery";
import TranscriptPane from "@/components/TranscriptPane";

/** 🔹 tiny util: "1h2m3s" → 3723  •  "90" → 90 */
function toSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);            // plain seconds

  const re = /(\d+h)?(\d+m)?(\d+s)?/;
  const [, h, m, s] = raw.match(re) || [];
  return (
    (h ? parseInt(h) * 3600 : 0) +
    (m ? parseInt(m) * 60 : 0) +
    (s ? parseInt(s) : 0)
  ) || null;
}

export default async function VideoPage({
  params,
  searchParams,                           // ⬅️  comes from Next 15
}: {
  params:       { id: string };
  searchParams: { t?: string };
}) {
  // Explicitly await params and searchParams to address Next.js 15 warnings
  const resolvedParams = await Promise.resolve(params);
  const resolvedSearchParams = await Promise.resolve(searchParams);
  
  const { id } = resolvedParams;
  if (!/^[\w-]{11}$/.test(id)) notFound();

  const videoMeta = await fetchVideoMeta(id);
  if (!videoMeta) notFound();

  // Parse "t" (or "start") from the URL
  const startSec = toSeconds(resolvedSearchParams.t) ?? null;

  /* ----------- RENDER ---------- */
  return (
    <main className="flex flex-col min-h-screen items-center p-4 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-4 w-full max-w-4xl">{videoMeta.title}</h1>

      <div className="w-full max-w-4xl aspect-video mb-6">
        <iframe
          id={`player-${id}`}
          className="w-full h-full rounded-xl shadow-lg"
          src={`https://www.youtube.com/embed/${id}${
            startSec !== null ? `?start=${startSec}&autoplay=1` : ""
          }`}
          title={videoMeta.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>

      <TranscriptPane videoId={id} height={500} />

      <div className="w-full max-w-4xl bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 mb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <h2 className="text-sm text-gray-500 dark:text-gray-400">Channel</h2>
            <p className="font-medium">{videoMeta.channel}</p>
          </div>
          
          <div>
            <h2 className="text-sm text-gray-500 dark:text-gray-400">Published</h2>
            <p className="font-medium">
              {videoMeta.published ? 
                (typeof videoMeta.published === 'object' && videoMeta.published.value
                  ? videoMeta.published.value
                  : String(videoMeta.published))
                : 'Date not available'}
            </p>
          </div>

          <div>
            <h2 className="text-sm text-gray-500 dark:text-gray-400">Video Length</h2>
            <p className="font-medium">{videoMeta.video_length || 'Not available'}</p>
          </div>
          
          <div>
            <h2 className="text-sm text-gray-500 dark:text-gray-400">Speakers</h2>
            <p className="font-medium">{videoMeta.speakers || 'Not listed'}</p>
          </div>
        </div>
      </div>
    </main>
  );
}
