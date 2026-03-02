// src/lib/assistants.ts
// ─────────────────────────────────────────────────────────────
//  OpenAI Assistants configuration for speaker chat
//  Model: gpt-4.1 (upgraded from gpt-4o)
// ─────────────────────────────────────────────────────────────

export interface SpeakerAssistant {
  name: string;
  slug: string;
  assistantId: string;
  videoCount: number;
}

export const SPEAKER_ASSISTANTS: SpeakerAssistant[] = [
  {
    name: "Eliezer Yudkowsky",
    slug: "yudkowsky",
    assistantId: "asst_ZSrgyWlmv4RLQrj1Cyiyn8ob",
    videoCount: 44,
  },
  {
    name: "Liron Shapira",
    slug: "shapira",
    assistantId: "asst_BGgQsWk21FqaSCzKRIqJVeS0",
    videoCount: 123,
  },
];

export function getAssistantBySlug(
  slug: string,
): SpeakerAssistant | undefined {
  return SPEAKER_ASSISTANTS.find((s) => s.slug === slug);
}
