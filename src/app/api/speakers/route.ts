import { fetchAllSpeakers } from "@/lib/bigquery";
import { slugify } from "@/lib/speakers";

export async function GET() {
  const { speakers, total } = await fetchAllSpeakers(1, 10000);

  const result = speakers.map((s: { name: string; videoCount: number }) => ({
    name: s.name,
    slug: slugify(s.name),
    videoCount: s.videoCount,
  }));

  return Response.json({ speakers: result, total });
}
