// Check whether YouTube watch history is ON for the profile. Watch-seeding
// (watch.mjs) only shapes the Home feed when history is enabled.
// Exit codes: 0 history on · 1 history off/paused.
//
// Usage: node check-history.mjs
import { launchProfile } from './lib/profile.mjs';

const { ctx, page } = await launchProfile();
await page.goto('https://www.youtube.com/feed/history', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const body = await page.locator('body').innerText();
await ctx.close();

const off = /watch history is off|history is paused|turn on watch history/i.test(body);
console.log(JSON.stringify({ historyOn: !off, snippet: body.replace(/\s+/g, ' ').slice(0, 300) }));
if (off) {
  console.error('WATCH HISTORY IS OFF — enable it at https://myactivity.google.com/activitycontrols/youtube');
  process.exit(1);
}
