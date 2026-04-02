export const CLIP_RULES = {
  bestSnippets: `Find 1-3 moments from this transcript that would go viral on social media.
Look for: bold claims, hot takes, emotional intensity, surprising revelations,
funny exchanges, quotable one-liners, or "mic drop" moments.
Prefer clips where the speaker says something that stands alone without context.`,

  aiSafety: `Find 1-3 moments from this transcript about AI safety, alignment, existential risk,
or AI governance. Look for: warnings about superintelligence, debates about timelines,
alignment challenges, policy proposals, or vivid analogies about AI risk.`,

  general: `Find 1-3 clip-worthy moments from this transcript that match the user's query.
Focus on the most compelling, quotable, or emotionally resonant segments.`,

  shared: `RULES FOR GOOD CLIPS:
- Each clip must start and end on clean sentence boundaries
- Use the exact start timestamps from the transcript segments for startSec
- End timestamp = start of the last relevant segment + 4 seconds
- Prefer moments with strong standalone statements or emotional intensity
- Avoid clips that start mid-thought or end mid-sentence
- Ideal clip length: 30 seconds to 2 minutes. Maximum 3 minutes
- Description must be 100 characters or fewer — punchy, not a summary
- Return a JSON object with key "snippets" containing an array of objects
- Each object: { "startSec": number, "endSec": number, "description": string }
- Order by most viral/compelling first
- SPREAD clips across the ENTIRE transcript — do NOT cluster near the beginning
- If the transcript is 60 min, clips should come from early, middle, AND late portions
- If "ALREADY SUGGESTED" clips are listed, do NOT repeat or overlap those time ranges
- Never suggest a clip whose time range overlaps with a previously suggested clip`,
};
