import { notFound, redirect } from "next/navigation";
import { editorHref, timestampSeconds } from "@/lib/editor-link";

export default async function VideoPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string; start?: string; end?: string }>;
}) {
  const { id } = await params;
  if (!/^[\w-]{11}$/.test(id)) notFound();
  const query = await searchParams;
  redirect(editorHref(id, timestampSeconds(query.start ?? query.t), timestampSeconds(query.end)));
}
