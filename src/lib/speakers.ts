// src/lib/speakers.ts
// ─────────────────────────────────────────────────────────────
//  Speaker configuration for chat (Responses API)
//  Hybrid: shared vector store for all speakers + legacy per-speaker stores
// ─────────────────────────────────────────────────────────────

export interface SpeakerConfig {
    name: string;
    slug: string;
    vectorStoreId: string;
    videoCount: number;
    /** When true, use speaker metadata filter on the shared store */
    usesSharedStore?: boolean;
}

// Shared vector store for all speakers (batch 1: first 100 alphabetical)
export const SHARED_VECTOR_STORE_ID = "vs_69b1015315d88191b6f26c169575bc4c";

// Legacy per-speaker stores (still active until all speakers are in shared store)
export const LEGACY_SPEAKERS: SpeakerConfig[] = [
    {
        name: "Eliezer Yudkowsky",
        slug: "yudkowsky",
        vectorStoreId: "vs_69a4f63b41c081919d89517bdcea16b6",
        videoCount: 44,
    },
    {
        name: "Liron Shapira",
        slug: "shapira",
        vectorStoreId: "vs_69a4f6b6492c819196e91c0128bf44f2",
        videoCount: 123,
    },
];

// Re-export for backward compat
export const SPEAKERS = LEGACY_SPEAKERS;

export function slugify(name: string): string {
    return name
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

export function stripDiacritics(s: string): string {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function getSpeakerBySlug(
    slug: string,
): SpeakerConfig | undefined {
    // Check legacy speakers first
    const legacy = LEGACY_SPEAKERS.find((s) => s.slug === slug);
    if (legacy) return legacy;

    // For any other slug, it uses the shared store
    // The name will be resolved from the slug by the caller
    return undefined;
}

/**
 * Resolve a speaker slug to a config.
 * For legacy speakers, returns their dedicated store.
 * For all others, returns a config pointing at the shared store.
 */
export function resolveSpeaker(slug: string, name?: string): SpeakerConfig | undefined {
    // Legacy speakers with dedicated stores
    const legacy = LEGACY_SPEAKERS.find((s) => s.slug === slug);
    if (legacy) return legacy;

    // "all" = cross-speaker search
    if (slug === "all") {
        return {
            name: "All Speakers",
            slug: "all",
            vectorStoreId: SHARED_VECTOR_STORE_ID,
            videoCount: 0,
            usesSharedStore: true,
        };
    }

    // Dynamic speaker from shared store
    if (name) {
        return {
            name,
            slug,
            vectorStoreId: SHARED_VECTOR_STORE_ID,
            videoCount: 0,
            usesSharedStore: true,
        };
    }

    return undefined;
}
