// Seed watch history: play each video muted for N seconds so it registers.
//
// Gotcha this script exists for: YouTube plays a pre-roll ad first, and the
// <video> element's playhead advances DURING the ad — then resets to 0 for the
// main video. A naive "play for 60s" therefore watches the ad, not the video,
// and nothing lands in history. So we wait out / skip ads (#movie_player has
// class `ad-showing` while an ad runs) before starting the clock.
//
// Usage:
//   node watch.mjs [--seconds 60] <url-or-id> [<url-or-id> ...]
//   node watch.mjs [--seconds 60] --file urls.txt      (one url/id per line, # comments ok)
//
// ONLY feed this AI-safety-adjacent videos — anything else contaminates the
// sandbox's recommendations, which is the whole point of the account.
import fs from 'node:fs';
import { launchProfile, toWatchUrl } from './lib/profile.mjs';

const args = process.argv.slice(2);
let seconds = 60;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seconds') seconds = Number(args[++i]);
  else if (args[i] === '--file') {
    const lines = fs.readFileSync(args[++i], 'utf8').split('\n');
    for (const l of lines) {
      const t = l.trim();
      if (t && !t.startsWith('#')) inputs.push(t);
    }
  } else inputs.push(args[i]);
}
if (!inputs.length || !Number.isFinite(seconds) || seconds <= 0) {
  console.error('usage: node watch.mjs [--seconds 60] <url-or-id>... | --file urls.txt');
  process.exit(64);
}
const urls = inputs.map(toWatchUrl);

const { ctx, page } = await launchProfile();

const state = () =>
  page.evaluate(() => {
    const v = document.querySelector('video');
    const player = document.querySelector('#movie_player');
    if (v) {
      v.muted = true;
      if (v.paused) v.play().catch(() => {});
    }
    return {
      t: v ? v.currentTime : -1,
      paused: v ? v.paused : true,
      ad: player ? player.classList.contains('ad-showing') : false,
      title: document.title.replace(' - YouTube', ''),
    };
  });

const results = [];
for (const [i, url] of urls.entries()) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Wait out pre-roll ads, clicking Skip whenever it appears (up to 2 min).
  let s = await state();
  for (let w = 0; w < 40 && s.ad; w++) {
    await page
      .locator('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')
      .first()
      .click({ timeout: 1000 })
      .catch(() => {});
    await page.waitForTimeout(3000);
    s = await state();
  }
  console.log(`[${i + 1}/${urls.length}] ${s.title} — ad cleared, main video t=${s.t.toFixed(1)}s paused=${s.paused}`);

  const start = (await state()).t;
  await page.waitForTimeout(seconds * 1000);
  const end = await state();
  const delta = end.t - start;
  const ok = delta > Math.min(20, seconds / 3);
  results.push({ url, title: end.title, delta: Math.round(delta), ok });
  console.log(`[${i + 1}/${urls.length}] done — advanced ${Math.round(delta)}s ${ok ? 'OK' : 'FAILED'}`);
}
await ctx.close();

console.log('\nSUMMARY');
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(r.delta).padStart(4)}s  ${r.title}`);
const okCount = results.filter((r) => r.ok).length;
console.log(`${okCount}/${results.length} registered`);
process.exit(okCount === results.length ? 0 : 1);
