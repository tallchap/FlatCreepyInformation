
// src/app/video/[id]/page.tsx
import { notFound } from "next/navigation";

export default function VideoPage({ params }: { params: { id: string } }) {
  const { id } = params;

  // rudimentary guard: bail if it doesn't look like a YouTube ID
  if (!/^[\w-]{11}$/.test(id)) notFound();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-3xl aspect-video">
        <iframe
          className="w-full h-full rounded-xl shadow-lg"
          src={`https://www.youtube.com/embed/${id}`}
          title={`YouTube video ${id}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    </main>
  );
}
