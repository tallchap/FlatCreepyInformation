
export const runtime = "nodejs";
export const revalidate = 3600;          // cache each page for 1 h

import { notFound } from "next/navigation";
import { fetchVideoMeta } from "@/lib/bigquery";
import { format } from "date-fns";

export default async function VideoPage({ params }: { params: { id: string } }) {
  // Explicitly await the params to handle Next.js dynamic route parameters correctly
  const id = params?.id;
  if (!/^[\w-]{11}$/.test(id)) notFound();

  const meta = await fetchVideoMeta(id);
  if (!meta) notFound();

  const dateNice = format(new Date(meta.published), "MMM d, yyyy");

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      {/* Metadata card */}
      <section className="rounded-xl bg-white shadow-md p-6">
        <h1 className="text-2xl font-semibold mb-2">{meta.title}</h1>

        <div className="text-sm text-gray-600 flex flex-wrap gap-3">
          <span className="font-medium">{meta.channel}</span>
          <span>•</span>
          <time dateTime={meta.published}>{dateNice}</time>
          <span>•</span>
          <a
            href={meta.youtube_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            View on YouTube
          </a>
        </div>
      </section>

      {/* Video embed */}
      <div className="aspect-video w-full rounded-xl overflow-hidden shadow-lg">
        <iframe
          className="w-full h-full"
          src={`https://www.youtube.com/embed/${id}`}
          title={`YouTube video ${id}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    </main>
  );
}
