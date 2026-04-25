import type { MetadataRoute } from "next";

const AI_BOTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "Google-Extended",
  "PerplexityBot",
  "CCBot",
  "Bytespider",
  "FacebookBot",
  "Meta-ExternalAgent",
  "Amazonbot",
  "Applebot-Extended",
  "cohere-ai",
  "Diffbot",
  "ImagesiftBot",
  "Omgilibot",
  "Timpibot",
  "YouBot",
];

const BLOCKED_PATHS = ["/expenses", "/api/expenses"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", disallow: BLOCKED_PATHS },
      // Many AI crawlers only honor rules under their specific User-agent,
      // not under "*". Repeat the disallow for each known bot.
      ...AI_BOTS.map((ua) => ({ userAgent: ua, disallow: BLOCKED_PATHS })),
    ],
  };
}
