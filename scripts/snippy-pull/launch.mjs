// Open the snippysaurus profile in a headed Chrome window and keep it open.
// Use this to (re-)sign in as the sandbox account; the session persists in the
// profile dir. Close the window or Ctrl+C to exit — and do exit before running
// any other script here (the profile can only be driven by one instance).
//
// Usage: node launch.mjs [url]
import { launchProfile, PROFILE_DIR, SANDBOX_EMAIL } from './lib/profile.mjs';

const url = process.argv[2] || 'https://www.youtube.com';
const { ctx, page } = await launchProfile({ viewport: null });
await page.goto(url);
console.log(`Snippysaurus profile (${PROFILE_DIR}) open at ${url}.`);
console.log(`Sign in as ${SANDBOX_EMAIL || 'the sandbox account (SNIPPY_ACCOUNT_EMAIL)'} if prompted. Close the window or Ctrl+C to exit.`);
await new Promise((resolve) => ctx.on('close', resolve));
