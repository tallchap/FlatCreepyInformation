
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
      {videoMeta ? (
        <>
          <h1 className="text-2xl font-bold mb-4 w-full max-w-4xl">{videoMeta.title}</h1>
          
          <div className="w-full max-w-4xl aspect-video mb-6">
            <iframe
              className="w-full h-full rounded-xl shadow-lg"
              src={`https://www.youtube.com/embed/${id}`}
              title={videoMeta?.title || `YouTube video ${id}`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>

          <div className="w-full max-w-4xl bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 mb-8">
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
        </>
      ) : (
        <div className="w-full max-w-4xl bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 mb-8">
          <h1 className="text-2xl font-bold mb-4">Video ID: {id}</h1>
          <p className="text-gray-500 dark:text-gray-400">Additional metadata not available</p>
        </div>
      )}
    </main>
  );
}
