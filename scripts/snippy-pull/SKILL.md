---
name: snippy-pull
description: >
  Pull a snapshot of the snippysaurus YouTube sandbox Home feed: scrape 100
  full videos (no Shorts, no ads) in feed order, enrich via YouTube Data API,
  append as a new tab in the tracking Google Sheet. Also seeds watch history.
  Use when: "snippy-pull", "snippy pull", "snapshot the feed", "snapshot
  youtube homepage", "new run of the spreadsheet", "pull the snippysaurus feed",
  "seed the snippysaurus account", "watch these on snippysaurus".
---

# /snippy-pull — Home-feed snapshot for the snippysaurus sandbox

A dedicated sandbox Google account (identity in `.env.local`: `SNIPPY_ACCOUNT_EMAIL`,
`SNIPPY_ACCOUNT_NAME`) watches AI-safety videos so its Home feed reflects what YouTube shows an AI-safety viewer. This
skill pulls one snapshot of that feed into the tracking sheet, or seeds the
account's watch history. Full docs: `README.md` next to this file.

Canonical source: `tallchap/FlatCreepyInformation` → `scripts/snippy-pull/`.

**Tracking sheet:** "Snippysaurus YT Home", id in `SNIPPY_SHEET_ID` — one tab per
pull; `enrich-append.py` prints the tab URL.

## Snapshot (the default request)

Run from this skill's directory (`<skill-dir>`):

1. First time on a machine: `npm install` (playwright-core, uses installed Chrome)
   and `pip3 install -r requirements.txt`.
2. `./pull.sh [suffix] --open` — does all of:
   - kills a lingering `launch.mjs`, since only one Playwright instance can
     drive the profile;
   - `node check-signed-in.mjs` — exits 1 if signed out, 2 if signed in as the
     wrong account. **On exit 1, stop and ask Ori to re-sign-in via
     `node launch.mjs`** (password is not stored). On exit 2, stop — never pull
     under another account.
   - `node scrape-home.mjs` → `runs/yt-home-<date>.json` (100 non-Shorts,
     non-ad videos in feed order; ~30 s, headed);
   - `python3 enrich-append.py <json> [suffix]` → new tab
     `Run N — YYYY-MM-DD[ suffix]` with rank, published (exact ISO), channel,
     title, description, duration (`[h]:mm:ss`), views, url, channel_url.
3. Report the tab URL and row count (open it — `--open` does). If asked how the
   feed shifted, diff video ids against the previous tab and summarize turnover
   and notable arrivals.

## Seeding watch history

`node watch.mjs --seconds 60 <url-or-id>...` (or `--file seeds.txt`). Only
AI-safety-adjacent videos — anything else contaminates the sandbox. The script
waits out pre-roll ads before timing, because the playhead advances during ads
and then resets. Check `node check-history.mjs` first if a seed run registers
nothing.

## Wiring
- Env: `YOUTUBE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `SNIPPY_SHEET_ID`,
  `SNIPPY_ACCOUNT_EMAIL`, `SNIPPY_ACCOUNT_NAME` from the repo root `.env.local` (or `~/Desktop/ClaudeCode/FlatCreepyInformation/.env.local`,
  or `SNIPPY_ENV_FILE`).
- Chrome profile: `~/chrome-profiles/snippysaurus` (`SNIPPY_PROFILE_DIR`).
  Machine-local, never committed.

## Curation after collection — Ori feedback, 2026-09-08

Keep raw Home-feed snapshots complete and in feed order; apply this policy to the curated shortlist, not by silently changing the raw scrape.

- Primary sources are the main priority: original interviews, firsthand talks, research presentations, and demonstrations by the people doing the work. An original upload is not automatically a primary source for its claims.
- Wes Roth, Riley Brown, Matthew Barnett, and Rowan Cheung are excluded by default from recommendations across YouTube and Twitter/X: reactions, recaps, commentary on other people's work, and rehosted excerpts do not qualify. Their original podcast interviews may qualify when the actual interview is verified; a podcast label or title keyword alone is insufficient. When uncertain, hold for review instead of including.
- AI-safety relevance comes before general AI popularity or engineering utility. The top five should directly address catastrophic AI risk, alignment/control, dangerous capabilities, or safety governance. Generic coding, agent tooling, permissions, and reliability discussions do not qualify without a concrete AI-safety connection. Do not pad the safety shortlist with generic AI content.
- State which platforms were actually collected, including whether Twitter/X was included; never imply cross-platform aggregation when only YouTube was sourced.
- Use reaction videos as discovery leads to locate the original interview, talk, paper, or demonstration. Prefer that primary source and deduplicate derivative coverage of the same event.
- Record source type, named speakers, evidence for any exception, and inclusion/exclusion reason. Put speaker names first in report clip titles; do not infer a speaker from a channel name. Mark unidentified speakers explicitly.
- Reports must state upfront whether Claude-in-Chrome / the dedicated sandbox Home scrape actually ran, or whether discovery used public search. Never label a manual sourcing report as a scraper run.
- Provide a transcript dropdown for each clip. Include only collected transcript text with provenance and timing, or explicitly say 'Transcript not collected'. A summary or chapter label is not a transcript.

## Required aggregation inputs and ranking — Ori feedback, 2026-09-09

- Execute the existing discovery actuators, not merely a manual web-search substitute. Use the dedicated Home-feed pull where available; also collect web search, Twitter/X search, YouTube search and the latest Grabien Morning Clip List from the connected inbox. Record each actuator, query, time window, run ID, result count, failures and usage/cost data independently. Do not claim a platform ran if it did not.
- Search implementations: tallchap/youtube-research-server shared.py (Brave web/video and YouTube metadata), tallchap/doom-research app.py (_search_youtube_videos), tallchap/twitter-research-server app.py (twitter_search); for topic surveys use the direct TwitterAPI.io search client rather than the single-tweet hunting agent. Use actual engagement snapshots, not invented trend scores; engagement ranks below source quality and AI-safety message fit.
- Recency is a strong ranking factor, NOT an eligibility cutoff. Start with current news and widen to older original interviews/talks whenever they supply a more on-message, newsworthy, Vitrupo-worthy moment. Display original publication/recording dates and the current news connection; do not pass a repost off as a new statement.
- Vitrupo-worthy means an identifiable speaker, a striking specific/high-stakes claim, a standalone payoff, and a verbatim evidence-backed quote. Preserve qualifications and context; sensational editorial wording must not exaggerate the source. Consult tallchap/custom-skills vitrupo-tweet/SKILL.md for hook selection.
- Grabien: read each latest newsletter in full, extract AI mentions and adjacent data-center/automation governance leads, inspect linked clips for relevance, identify the actual speaker and original broadcaster/interview, and distinguish direct safety content from adjacent policy material. Record newsletter date and count reviewed even if there are no relevant items. Publish clean public source URLs, not recipient-specific tracking/unsubscribe links or private email metadata. Never label a newsletter headline as a verified video transcript.
- If the desktop workflow is required and local access is absent, try the existing Shadow Relay worker to run snippy-pull there. A posted job or bridge wake is not successful collection; require claimed execution, returned data and a validated response or report the precise blocker.
