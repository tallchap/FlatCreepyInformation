import sharedCitationMap from "@/lib/shared-store-citation-map.json";
import { LEGACY_SPEAKERS, slugify } from "@/lib/speakers";

interface FileEntry {
  videoId: string;
  speaker: string;
  title: string;
}

export async function GET() {
  // Extract unique speakers + video counts from shared store citation map
  const speakerVideos = new Map<string, Set<string>>();

  const files = (sharedCitationMap as { files: Record<string, FileEntry> }).files;
  for (const entry of Object.values(files)) {
    const name = entry.speaker;
    if (!speakerVideos.has(name)) {
      speakerVideos.set(name, new Set());
    }
    speakerVideos.get(name)!.add(entry.videoId);
  }

  const result = new Map<string, { name: string; slug: string; videoCount: number }>();

  // Add shared store speakers
  for (const [name, videos] of speakerVideos) {
    const slug = slugify(name);
    result.set(slug, { name, slug, videoCount: videos.size });
  }

  // Merge legacy speakers (override if already present)
  for (const s of LEGACY_SPEAKERS) {
    result.set(s.slug, { name: s.name, slug: s.slug, videoCount: s.videoCount });
  }

  const speakers = [...result.values()].sort((a, b) => b.videoCount - a.videoCount);

  return Response.json({ speakers, total: speakers.length });
}
