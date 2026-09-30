export const FEATURED_SPEAKERS = [
  { name: "Sam Altman", slug: "sam-altman", color: "#ddebba" },
  { name: "Elon Musk", slug: "elon-musk", color: "#d3dee9" },
  { name: "Dario Amodei", slug: "dario-amodei", color: "#f2cfbb" },
  { name: "Geoffrey Hinton", slug: "geoffrey-hinton", color: "#c9dde8" },
  { name: "Eliezer Yudkowsky", slug: "eliezer-yudkowsky", color: "#e9ccd8" },
  { name: "Demis Hassabis", slug: "demis-hassabis", color: "#d8d6f1" },
  { name: "Yoshua Bengio", slug: "yoshua-bengio", color: "#eee0aa" },
  { name: "Max Tegmark", slug: "max-tegmark", color: "#cce3d6" },
] as const;
export const SEARCH_SPEAKERS = [
  ...FEATURED_SPEAKERS,
  { name: "Any speaker", slug: "all", color: "#dde5d3" },
] as const;
export const CHAT_HANDOFF_KEY = "snippysaurus:new-chat";
export const SUGGESTIONS = [
  {
    label: "AI could change everything",
    topic: "how AI could change everything",
    icon: "✧",
  },
  {
    label: "The risks of superintelligence",
    topic: "the risks of superintelligence",
    icon: "↗",
  },
  {
    label: "A surprising prediction",
    topic: "a surprising prediction",
    icon: "⚡",
  },
];
export function readChatHandoff(
  raw: string | null,
): { speaker: string; name: string; prompt: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const person = SEARCH_SPEAKERS.find(
      (speaker) => speaker.slug === value.speaker,
    );
    if (
      !person ||
      typeof value.prompt !== "string" ||
      !value.prompt.trim() ||
      value.prompt.length > 5000
    )
      return null;
    return {
      speaker: person.slug,
      name: person.name,
      prompt: value.prompt.trim(),
    };
  } catch {
    return null;
  }
}

export function speakerPortrait(slug: string) {
  return `/speakers/${slug}.${slug === "dario-amodei" ? "webp" : "jpg"}`;
}
