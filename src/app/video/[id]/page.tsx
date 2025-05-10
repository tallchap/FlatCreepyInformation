
// src/app/video/[id]/page.tsx
import { notFound } from "next/navigation";
import { fetchVideoMeta } from "@/lib/bigquery";
import { format } from "date-fns";

export default async function VideoPage({ params }: { params: { id: string } }) {
  // Get the video ID from the URL parameters
  const id = params?.id;
  
  // Validate the video ID format
  if (!id || !/^[\w-]{11}$/.test(id)) notFound();

  // Fetch metadata from BigQuery
  const meta = await fetchVideoMeta(id).catch(() => undefined);

  // Format the date if available
  const formattedDate = meta?.published 
    ? format(new Date(meta.published), "MMMM d, yyyy")
    : null;

  return (
    <main className="max-w-4xl mx-auto py-8 px-4">
      {/* Video Player */}
      <div className="w-full aspect-video rounded-xl overflow-hidden shadow-lg mb-6">
        <iframe
          className="w-full h-full"
          src={`https://www.youtube.com/embed/${id}`}
          title={meta?.title || `YouTube video ${id}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>

      {/* Video Metadata */}
      {meta ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-6 mb-6">
          <h1 className="text-2xl font-bold mb-3">{meta.title}</h1>
          
          <div className="flex flex-wrap gap-y-2 text-sm text-gray-500 dark:text-gray-400">
            <div className="w-full md:w-auto md:mr-6">
              <span className="font-medium">Channel:</span> {meta.channel}
            </div>
            
            {formattedDate && (
              <div className="w-full md:w-auto md:mr-6">
                <span className="font-medium">Published:</span> {formattedDate}
              </div>
            )}
            
            <div className="w-full md:w-auto mt-2 md:mt-0">
              <a 
                href={meta.youtube_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Watch on YouTube
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-xl p-6 mb-6">
          <h1 className="text-xl font-medium text-yellow-800 dark:text-yellow-500 mb-2">
            Video ID: {id}
          </h1>
          <p className="text-yellow-700 dark:text-yellow-400">
            Additional metadata unavailable. This video might not be in our database yet.
          </p>
        </div>
      )}
    </main>
  );
}
