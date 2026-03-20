import { fetchAllSpeakers } from "@/lib/bigquery";
import { slugify } from "@/lib/speakers";

export async function GET() {
  // Fetch live speaker counts from BigQuery
  const { speakers: bqSpeakers } = await fetchAllSpeakers(1, 10000);

  const result = new Map<string, { name: string; slug: string; videoCount: number }>();

  for (const s of bqSpeakers) {
    const slug = slugify(s.name);
    result.set(slug, { name: s.name, slug, videoCount: s.videoCount });
  }

  const speakers = [...result.values()].sort((a, b) => a.name.localeCompare(b.name));

  return Response.json({ speakers, total: speakers.length });
}
