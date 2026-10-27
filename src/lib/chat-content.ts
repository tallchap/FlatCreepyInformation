import {
  editorHref,
  timestampSeconds,
  youtubeLinkTarget,
} from "@/lib/editor-link";

/**
 * Clean a numbered suggestion line: strip number prefix, leading "or ",
 * trailing comma/period, and trim whitespace.
 */
function cleanSuggestion(raw: string): string {
  return raw
    .replace(/^\d+\.\s*/, "")
    .replace(/^or\s+/i, "")
    .replace(/[,.]$/, "")
    .trim();
}

/**
 * Turn markdown-ish links into clickable anchors, convert
 * youtube:VIDEO_ID citations into Snippysaurus video links,
 * strip OpenAI file-search annotations, make numbered follow-ups
 * clickable, and preserve formatting.
 */
export function formatChatContent(text: string): string {
  const links: string[] = [];
  const keep = (link: string) => `\u0000${links.push(link) - 1}\u0000`;
  const videoLink = (title: string, videoId: string, startSec: number) =>
    `<a href="${editorHref(videoId, startSec)}" data-video-id="${videoId}" data-start-sec="${startSec}" data-video-title="${encodeURIComponent(title)}" class="inline-flex items-center gap-1 font-medium underline decoration-[#d4cdb8] underline-offset-4 text-[#1f2e25] hover:decoration-[#1f2e25]"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="inline"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>${title}</a>`;
  // Tokenize links before formatting so a bare-URL matcher never nests anchors
  // inside a markdown link or rewrites its attributes.
  return text
    .replace(/[\u3010][^\u3011]*[\u3011]/g, "")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(
      /\[((?:[^\[\]]|\[[^\]]*\])*)\]\((youtube:[\w-]{11}(?::\d+(?:\.\d+)?)?|https?:\/\/[^\s)]+)\)/g,
      (_match, title: string, url: string) => {
        const citation = url.match(
          /^youtube:([\w-]{11})(?::(\d+(?:\.\d+)?))?$/,
        );
        const target = citation
          ? {
              videoId: citation[1],
              startSec: timestampSeconds(citation[2]) ?? 0,
            }
          : youtubeLinkTarget(url);
        return keep(
          target
            ? videoLink(title, target.videoId, target.startSec)
            : `<a href="${url}" target="_blank" rel="noopener noreferrer" class="underline decoration-[#d4cdb8] underline-offset-4 text-[#1f2e25] hover:decoration-[#1f2e25]">${title}</a>`,
        );
      },
    )
    .replace(
      /https?:\/\/(?:www\.|m\.)?(?:youtu\.be|youtube\.com)\/[^\s<>"')]+/g,
      (raw) => {
        const url = raw.replace(/[.,;!?]+$/, "");
        const target = youtubeLinkTarget(url);
        return target
          ? keep(videoLink(url, target.videoId, target.startSec)) +
              raw.slice(url.length)
          : raw;
      },
    )
    .replace(/^(\d+\.\s+.+)$/gm, (_match, line: string) => {
      if (line.includes("\u0000")) return line; // Numbered video results are links, not follow-up prompts.
      const cleaned = cleanSuggestion(line);
      return `<span data-suggestion="${encodeURIComponent(cleaned)}" class="cursor-pointer underline text-emerald-600 hover:text-emerald-800">${cleaned}</span>`;
    })
    .replace(/\n/g, "<br />")
    .replace(
      /\u0000(\d+)\u0000/g,
      (_match, index: string) => links[Number(index)],
    );
}
