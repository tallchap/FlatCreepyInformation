import { fetchAllSpeakers } from "@/lib/bigquery";
import { LEGACY_SPEAKERS, slugify } from "@/lib/speakers";

export async function GET() {
  // Fetch live speaker counts from BigQuery
  const { speakers: bqSpeakers } = await fetchAllSpeakers(1, 10000);

  const result = new Map<string, { name: string; slug: string; videoCount: number }>();

  for (const s of bqSpeakers) {
    const slug = slugify(s.name);
    result.set(slug, { name: s.name, slug, videoCount: s.videoCount });
  }

  // Merge legacy speakers (override if already present — they have dedicated vector stores)
  for (const s of LEGACY_SPEAKERS) {
    result.set(s.slug, { name: s.name, slug: s.slug, videoCount: s.videoCount });
  }

  const speakers = [...result.values()].sort((a, b) => a.name.localeCompare(b.name));

  return Response.json({ speakers, total: speakers.length });
}
