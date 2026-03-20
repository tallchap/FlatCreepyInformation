// src/lib/speakers.ts
// ─────────────────────────────────────────────────────────────
//  Speaker configuration for chat (Responses API)
//  All speakers use the shared vector store with metadata filters
// ─────────────────────────────────────────────────────────────

export interface SpeakerConfig {
    name: string;
    slug: string;
    vectorStoreId: string;
    videoCount: number;
    /** When true, use speaker metadata filter on the shared store */
    usesSharedStore?: boolean;
}

// Shared vector store for all speakers
export const SHARED_VECTOR_STORE_ID = "vs_69b1015315d88191b6f26c169575bc4c";

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

/**
 * Resolve a speaker slug to a config.
 * All speakers use the shared vector store with metadata filters.
 */
export function resolveSpeaker(slug: string, name?: string): SpeakerConfig | undefined {
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

    // All speakers use shared store
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
