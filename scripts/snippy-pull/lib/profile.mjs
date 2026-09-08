// Shared launcher for the snippysaurus Chrome profile.
//
// The profile dir holds the signed-in Google session for the sandbox account.
// It is machine-local (cookies!) and is never committed. Override the location
// with SNIPPY_PROFILE_DIR. Only ONE Playwright instance can drive the profile
// at a time — close launch.mjs before running any other script.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load the first existing .env.local into process.env (never overriding what
 * is already set). Same search order as enrich-append.py: SNIPPY_ENV_FILE, the
 * repo root, then the canonical FlatCreepyInformation checkout.
 */
export function loadEnv() {
  const candidates = [
    process.env.SNIPPY_ENV_FILE,
    path.resolve(HERE, '..', '..', '..', '.env.local'),
    path.join(os.homedir(), 'Desktop', 'ClaudeCode', 'FlatCreepyInformation', '.env.local'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
    return file;
  }
  return null;
}
loadEnv();

// Identity of the sandbox account. Kept out of the (public) repo: set
// SNIPPY_ACCOUNT_EMAIL and SNIPPY_ACCOUNT_NAME in .env.local.
export const SANDBOX_EMAIL = process.env.SNIPPY_ACCOUNT_EMAIL || '';
export const SANDBOX_NAME = process.env.SNIPPY_ACCOUNT_NAME || '';

export const PROFILE_DIR =
  process.env.SNIPPY_PROFILE_DIR || path.join(os.homedir(), 'chrome-profiles', 'snippysaurus');

/**
 * Launch the persistent profile in real Chrome. Always headed: YouTube treats
 * headless Chromium as a bot and the recommendations feed degrades.
 * Pass `viewport: null` to size the page to the window (interactive use).
 * Returns { ctx, page }.
 */
export async function launchProfile({ viewport = { width: 1440, height: 900 } } = {}) {
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    console.warn(`profile dir ${PROFILE_DIR} did not exist — created empty. Sign in with: node launch.mjs`);
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { ctx, page };
}

/** Accept a full watch URL, a youtu.be link, or a bare 11-char video id. */
export function toWatchUrl(input) {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`;
  const u = new URL(s);
  const id = u.hostname.endsWith('youtu.be') ? u.pathname.slice(1) : u.searchParams.get('v');
  if (!id) throw new Error(`not a YouTube video url/id: ${input}`);
  return `https://www.youtube.com/watch?v=${id}`;
}
