// Verify the profile is signed in to YouTube, and as the sandbox account.
// Prints one JSON line. Exit codes: 0 signed in as sandbox · 1 signed out ·
// 2 signed in as some other account (which would contaminate the feed) ·
// 3 SNIPPY_ACCOUNT_EMAIL / SNIPPY_ACCOUNT_NAME not configured in .env.local.
//
// Usage: node check-signed-in.mjs
import { launchProfile, SANDBOX_EMAIL, SANDBOX_NAME } from './lib/profile.mjs';

if (!SANDBOX_EMAIL && !SANDBOX_NAME) {
  console.error('SNIPPY_ACCOUNT_EMAIL / SNIPPY_ACCOUNT_NAME not set — add them to .env.local (see README)');
  process.exit(3);
}

const { ctx, page } = await launchProfile();
await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const avatarButtons = await page.locator('#avatar-btn').count();
const signInLinks = await page.locator('a[aria-label="Sign in"]').count();

let menu = '';
if (avatarButtons > 0) {
  await page.locator('#avatar-btn').first().click();
  await page.waitForTimeout(2000);
  menu = await page
    .locator('ytd-active-account-header-renderer, yt-multi-page-menu-section-renderer')
    .first()
    .innerText()
    .catch(() => '');
}
await ctx.close();

const account = menu.replace(/\s+/g, ' ').trim().slice(0, 200);
const signedIn = avatarButtons > 0 && signInLinks === 0;
const asSandbox =
  (SANDBOX_EMAIL && account.includes(SANDBOX_EMAIL)) || (SANDBOX_NAME && account.includes(SANDBOX_NAME));
console.log(JSON.stringify({ signedIn, asSandbox: Boolean(asSandbox), avatarButtons, signInLinks, account }));

if (!signedIn) {
  console.error(`NOT SIGNED IN — run \`node launch.mjs\` and sign in as ${SANDBOX_EMAIL}`);
  process.exit(1);
}
if (!asSandbox) {
  console.error(`signed in but NOT as ${SANDBOX_EMAIL} — refusing to continue (feed contamination)`);
  process.exit(2);
}
