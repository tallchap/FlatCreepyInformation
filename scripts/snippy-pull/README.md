# snippy-pull — YouTube Home-feed snapshots for the snippysaurus sandbox

A dedicated sandbox Google account (created 2026-07-26; its identity lives in
`.env.local`, not here — this repo is public) does nothing but watch AI-safety
videos on YouTube. Its Home feed is therefore a clean sample of *what YouTube
recommends to an AI-safety viewer*. This module drives that account through a
persistent, signed-in Chrome profile and records each Home-feed snapshot as a
new tab in the tracking sheet.

**Tracking sheet:** "Snippysaurus YT Home" (id in `SNIPPY_SHEET_ID`) — one tab per
pull, named `Run N — YYYY-MM-DD[ suffix]`. `enrich-append.py` prints the tab URL.

## Files

| File | What it does |
|------|--------------|
| `pull.sh` | End-to-end: signed-in check → scrape → enrich + append tab. `[suffix] [--dry-run] [--open]` |
| `check-signed-in.mjs` | Exit 0 only if the profile is signed in **as the sandbox account** (1 = signed out, 2 = wrong account) |
| `scrape-home.mjs` | Scroll Home, collect the first 100 full videos in feed order (no Shorts, no ads) → JSON |
| `enrich-append.py` | YouTube Data API metadata for those ids → new tab in the sheet. `--dry-run` writes nothing |
| `watch.mjs` | Seed watch history: play videos muted for N s, **after** waiting out pre-roll ads |
| `check-history.mjs` | Confirm watch history is ON (seeding does nothing while it is paused) |
| `launch.mjs` | Open the profile in a headed Chrome window and keep it open — use to (re-)sign in |
| `lib/profile.mjs` | Shared launcher (profile path, real Chrome channel, automation flag) |

Only video ids from the scrape matter; the API is the source of truth for
title, channel, exact publish datetime, numeric views and duration.

## Setup (once per machine)

```bash
cd scripts/snippy-pull
npm install                          # playwright-core only — uses your installed Google Chrome
pip3 install -r requirements.txt     # google-auth + google-api-python-client
node launch.mjs                      # sign in as the sandbox account, then close the window
node check-signed-in.mjs             # expect {"signedIn":true,"asSandbox":true,...}
```

The Chrome profile lives at `~/chrome-profiles/snippysaurus` (override with
`SNIPPY_PROFILE_DIR`). It holds the login session, so it is machine-local and
never committed. The account password is not stored anywhere — if the session
expires, sign in again through `launch.mjs`.

### Configuration

`enrich-append.py` reads these from the environment, else from the first
`.env.local` it finds (`SNIPPY_ENV_FILE`, the repo root, or
`~/Desktop/ClaudeCode/FlatCreepyInformation/.env.local`):

| Var | Purpose |
|-----|---------|
| `YOUTUBE_API_KEY` | Data API v3 key. ~2 quota units per 100 videos (10,000/day free) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Service-account JSON; the SA must be an Editor on the sheet |
| `SNIPPY_SHEET_ID` | Id of the tracking sheet |
| `SNIPPY_ACCOUNT_EMAIL`, `SNIPPY_ACCOUNT_NAME` | Sandbox identity; `check-signed-in.mjs` refuses to run under any other account |

All five live in the root `.env.local` on the canonical machine. `lib/profile.mjs`
loads the same file for the Node scripts.

## Usage

```bash
./pull.sh                    # new tab "Run N — <today>"
./pull.sh post-watch         # new tab "Run N — <today> post-watch"
./pull.sh --dry-run          # everything except the sheet write
./pull.sh --open             # …and open the new tab when done

node watch.mjs --seconds 60 https://www.youtube.com/watch?v=… <id> …
node watch.mjs --file seeds.txt
```

A typical experiment: `./pull.sh baseline` → `node watch.mjs --file seeds.txt`
→ `./pull.sh post-watch`, then diff the two tabs' video ids to measure feed
turnover. (2026-08-06: 12 seeded AI-safety videos produced a 97% turnover
toward AI content — AXRP, Anthropic, Palisade, Kurzweil.)

## Rules and gotchas

- **Never use this profile for anything but AI-safety-adjacent watching.**
  One stray video contaminates the recommendations the whole account exists to
  measure. `check-signed-in.mjs` refuses to proceed under any other account.
- **One driver at a time.** The persistent profile can only be opened by one
  Playwright instance. Close `launch.mjs` before running anything else
  (`pull.sh` does this for you).
- **Always headed, always real Chrome.** Headless Chromium is fingerprinted as a
  bot and the feed degrades. `channel: 'chrome'` + `--disable-blink-features=AutomationControlled`
  is what let Google sign-in work without the "browser not secure" block.
- **Ads fake the playhead.** During a pre-roll the `<video>` element's
  `currentTime` advances, then resets for the real video. `watch.mjs` waits for
  `#movie_player.ad-showing` to clear (clicking Skip when offered) before
  starting its 60-second clock — a naive `play()` registers nothing.
- Sheets treats a leading `=` or `+` in a description as a formula; the enricher
  prefixes those with `'`.

## History

Built 2026-08-06 as loose scripts in `~/chrome-profiles/` plus the
`/snippy-pull` Claude Code skill; consolidated into this module 2026-09-08.
`SKILL.md` in this folder is that skill — symlink `~/.claude/skills/snippy-pull`
here to keep the skill and the code in one place.
