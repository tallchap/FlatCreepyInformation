// Scrape the sandbox account's YouTube Home feed in feed order: the first N
// full videos, skipping Shorts and ad slots. Only the ids matter — titles and
// channels here are a fallback; enrich-append.py fetches the real metadata
// from the Data API.
//
// Usage: node scrape-home.mjs [out.json] [--target 100]
//   default out: runs/yt-home-<YYYY-MM-DD>.json (runs/ is gitignored)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchProfile } from './lib/profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let target = 100;
let outJson = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target') target = Number(args[++i]);
  else outJson = args[i];
}
if (!outJson) {
  fs.mkdirSync(path.join(HERE, 'runs'), { recursive: true });
  outJson = path.join(HERE, 'runs', `yt-home-${new Date().toISOString().slice(0, 10)}.json`);
}

const { ctx, page } = await launchProfile();
await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const extract = () =>
  page.evaluate(() => {
    const items = [];
    for (const el of document.querySelectorAll('ytd-rich-item-renderer')) {
      if (el.querySelector('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer')) continue;
      if (el.querySelector('a[href^="/shorts/"], ytm-shorts-lockup-view-model')) continue;
      const link = el.querySelector(
        'a.ytLockupMetadataViewModelTitle[href*="/watch"], a#video-title-link[href*="/watch"], a[href*="/watch?v="]',
      );
      if (!link) continue;
      const url = new URL(link.getAttribute('href'), 'https://www.youtube.com');
      const id = url.searchParams.get('v');
      if (!id) continue;
      const title = (
        el.querySelector('h3[title]')?.getAttribute('title') ||
        el.querySelector('.ytLockupMetadataViewModelTitle span, #video-title')?.textContent ||
        ''
      ).trim();
      const channelLink = el.querySelector('.ytContentMetadataViewModelMetadataRow a');
      const channel = (channelLink?.textContent || '').trim();
      const channelUrl = channelLink
        ? new URL(channelLink.getAttribute('href'), 'https://www.youtube.com').href
        : '';
      items.push({ id, title, channel, channelUrl, url: `https://www.youtube.com/watch?v=${id}` });
    }
    return items;
  });

const seen = new Map();
let stale = 0;
for (let i = 0; i < 60 && seen.size < target; i++) {
  const batch = await extract();
  const before = seen.size;
  for (const v of batch) if (!seen.has(v.id) && v.title) seen.set(v.id, v);
  console.log(`pass ${i}: +${seen.size - before} → ${seen.size}`);
  stale = seen.size === before ? stale + 1 : 0;
  if (stale >= 6) {
    console.log('feed stopped loading new videos');
    break;
  }
  await page.evaluate(() => window.scrollBy(0, 2500));
  await page.waitForTimeout(1500);
}
await ctx.close();

const videos = [...seen.values()].slice(0, target);
fs.writeFileSync(outJson, JSON.stringify(videos, null, 2));
console.log(`DONE: ${videos.length} videos → ${outJson}`);
