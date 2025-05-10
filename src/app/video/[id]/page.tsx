
// src/app/video/[id]/page.tsx
import { notFound } from "next/navigation";
import { fetchVideoMeta } from "@/lib/bigquery";

export default async function VideoPage({ params }: { params: { id: string } }) {
  // Explicitly await the params to handle Next.js dynamic route parameters correctly
  const { id } = await Promise.resolve(params);

  // rudimentary guard: bail if it doesn't look like a YouTube ID
  if (!/^[\w-]{11}$/.test(id)) notFound();

  // Fetch video metadata from BigQuery
  const videoMeta = await fetchVideoMeta(id);

  return (
    <main className="flex flex-col min-h-screen items-center p-4 max-w-6xl mx-auto">
      <div className="w-full max-w-4xl aspect-video mb-6">
        <iframe
          className="w-full h-full rounded-xl shadow-lg"
          src={`https://www.youtube.com/embed/${id}`}
          title={videoMeta?.title || `YouTube video ${id}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>

      {videoMeta ? (
        <div className="w-full max-w-4xl bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 mb-8">
          <h1 className="text-2xl font-bold mb-4">{videoMeta.title}</h1>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <h2 className="text-sm text-gray-500 dark:text-gray-400">Channel</h2>
              <p className="font-medium">{videoMeta.channel_name}</p>
            </div>
            
            <div>
              <h2 className="text-sm text-gray-500 dark:text-gray-400">Published</h2>
              <p className="font-medium">
                {videoMeta.published_at ? 
                  (typeof videoMeta.published_at === 'object' && videoMeta.published_at.value
                    ? videoMeta.published_at.value
                    : String(videoMeta.published_at))
                  : 'Date not available'}
              </p>
            </div>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
            <a 
              href={videoMeta.url || `https://www.youtube.com/watch?v=${id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
            >
              <span>Watch on YouTube</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-external-link">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
          </div>
        </div>
      ) : (
        <div className="w-full max-w-4xl bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 mb-8">
          <h1 className="text-2xl font-bold mb-4">Video ID: {id}</h1>
          <p className="text-gray-500 dark:text-gray-400">Additional metadata not available</p>
        </div>
      )}
    </main>
  );
}
