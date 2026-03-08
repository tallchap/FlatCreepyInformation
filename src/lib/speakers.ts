// src/lib/speakers.ts
// ─────────────────────────────────────────────────────────────
//  Speaker configuration for chat (Responses API)
//  Migrated from assistants.ts — vectorStoreId replaces assistantId
// ─────────────────────────────────────────────────────────────

export interface SpeakerConfig {
    name: string;
    slug: string;
    vectorStoreId: string;
    /** @deprecated Will be removed in PR 3 when route.ts migrates to Responses API */
    assistantId: string;
    videoCount: number;
}

export const SPEAKERS: SpeakerConfig[] = [
    {
        name: "Eliezer Yudkowsky",
        slug: "yudkowsky",
        vectorStoreId: "vs_69a4f63b41c081919d89517bdcea16b6",
        assistantId: "asst_ZSrgyWlmv4RLQrj1Cyiyn8ob",
        videoCount: 44,
    },
    {
        name: "Liron Shapira",
        slug: "shapira",
        vectorStoreId: "vs_69a4f6b6492c819196e91c0128bf44f2",
        assistantId: "asst_BGgQsWk21FqaSCzKRIqJVeS0",
        videoCount: 123,
    },
];

export function getSpeakerBySlug(
    slug: string,
): SpeakerConfig | undefined {
    return SPEAKERS.find((s) => s.slug === slug);
}
