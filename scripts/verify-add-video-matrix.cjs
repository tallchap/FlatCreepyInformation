// End-to-end proof of the YouTube-only workflow on the live site:
// /admin/add-video → paste URL → speaker → Add → "open the editor" → pick a
// range with a different editor control per case → playback controls → Export
// → the downloaded MP4. Media checks live in verify-add-video-matrix-media.py.
//
//   PLAYWRIGHT_MODULE=/abs/node_modules/playwright QA_OUT=qa-recordings/x \
//   node scripts/verify-add-video-matrix.cjs [caseId,caseId…]
//
// Writes QA_OUT/<videoId>/{result.json,clip.mp4,*.png} and QA_OUT/summary.json.
// Exits nonzero when any check fails. Adding a video is permanent (it joins
// search/chat); it refuses videos already in the library.

const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const SITE = (process.env.SITE || "https://www.snippysaurus.com").replace(/\/$/, "");
const OUT = path.resolve(process.env.QA_OUT || ".context/add-video-matrix");
const CONCURRENCY = Number(process.env.QA_CONCURRENCY || 3);

// method: how the range is chosen. extra: additional controls exercised.
const CASES = [
  { id: "50c9WL7KDsw", speaker: "Tiffany Janzen", year: 2026, ar: "16:9", method: "typed", start: 60, len: 300, extra: ["play-pause", "spacebar", "speed"] },
  { id: "omsuTsOmvsc", speaker: "Steve Omohundro", year: 2008, ar: "4:3", method: "transcript-click", start: 600, len: 180, extra: ["follow-toggle"] },
  { id: "i78P-K1RhjY", speaker: "Steve DiPaola", year: 2008, ar: "4:3", method: "transcript-click", start: 900, len: 150, extra: ["follow-toggle"] },
  { id: "HT540VrCDwg", speaker: "Peter Norvig", year: 2009, ar: "16:10", method: "drag", start: 300, len: 240, extra: ["zoom", "over-limit"] },
  { id: "MaItaCQcYIE", speaker: "Stefan Wess", year: 2014, ar: "16:9", method: "search", query: "intelligence", len: 60, extra: [] },
  { id: "V2klMCTfnCA", speaker: "Jurgen Schmidhuber", year: 2017, ar: "16:9", method: "nudge", start: 120, len: 120, extra: [] },
  { id: "3JOjzAgrylY", speaker: "Michael Stevens", year: 2019, ar: "16:9", method: "clip-finder", extra: [] },
  { id: "LuNN32Tmc9c", speaker: "Geoffrey Hinton", year: 2023, ar: "9:16 Short", method: "typed", start: 10, len: 30, extra: ["from-start", "last-3s"] },
  { id: "t-GP3mr4s80", speaker: "Curt Jaimungal", year: 2026, ar: "9:16", method: "transcript-click", start: 20, len: 90, extra: ["from-start"] },
  { id: "C3WpGKCFh2s", speaker: "Krishna Gupta", year: 2025, ar: "1:1", method: "typed", start: 200, len: 45, extra: [] },
  { id: "TAJRPPTt8yY", speaker: "Sean Kitching", year: 2024, ar: "2:1", method: "nudge", start: 30, len: 5, extra: [] },
];

const only = (process.argv[2] || "").split(",").filter(Boolean);
const cases = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;

function parseClock(t) {
  const p = t.trim().split(":").map(Number);
  return p.reduce((a, v) => a * 60 + v, 0);
}

let addLock = Promise.resolve();
function serialAdd(fn) { // adds rebuild the shared search windows: one at a time
  const run = addLock.then(fn, fn);
  addLock = run.catch(() => {});
  return run;
}

async function runCase(browser, c) {
  const dir = path.join(OUT, c.id);
  fs.mkdirSync(dir, { recursive: true });
  const r = { ...c, checks: [], startedAt: new Date().toISOString() };
  const check = (name, ok, detail) => { r.checks.push({ name, ok: !!ok, detail }); console.log(`[${c.id}] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  let shot = 0;
  const snap = async (label) => page.screenshot({ path: path.join(dir, `${String(++shot).padStart(2, "0")}-${label}.png`) }).catch(() => {});
  const sel = async () => {
    const el = page.getByTestId("segment-active");
    if (!(await el.count())) return null;
    return { in: Number(await el.getAttribute("data-in")), out: Number(await el.getAttribute("data-out")) };
  };
  const typeTime = async (label, sec) => {
    const input = page.getByRole("textbox", { name: label, exact: true });
    await input.fill(String(sec));
    await input.press("Enter");
    await page.waitForTimeout(250);
  };
  const now = async () => parseClock(await page.getByTestId("current-time").innerText());

  try {
    // ── 1. Add the video through the form ──
    await serialAdd(async () => {
      await page.goto(`${SITE}/admin/add-video`, { waitUntil: "networkidle" });
      await page.getByTestId("add-url").fill(`https://www.youtube.com/watch?v=${c.id}`);
      await page.getByTestId("add-url").press("Enter");
      await page.getByTestId("add-summary").waitFor({ timeout: 30000 });
      const refusal = page.getByTestId("add-refusal");
      if (await refusal.count()) throw new Error(`refused: ${await refusal.innerText()}`);
      // Resume: a video this matrix already added (YouTube-only) goes straight to the editor.
      const prev = path.join(dir, "added.json");
      if (process.env.QA_RESUME && fs.existsSync(prev) && (await page.locator("text=Already in the library (YouTube-only)").count())) {
        Object.assign(r, JSON.parse(fs.readFileSync(prev, "utf8")));
        check("add: every step succeeded (earlier run)", true, `${r.addSec?.toFixed(0)}s`);
        await page.getByRole("link", { name: "Open in the editor" }).click();
        return;
      }
      await page.getByTestId("add-speaker").fill(c.speaker);
      await snap("lookup");
      const t0 = Date.now();
      await page.getByTestId("add-submit").click();
      await page.locator('[data-testid=add-ready], li.text-red-600').first().waitFor({ timeout: 6 * 60000 });
      r.addSteps = await page.getByTestId("add-status").innerText();
      r.addSec = (Date.now() - t0) / 1000;
      await snap("added");
      const ok = await page.getByTestId("add-ready").count();
      check("add: every step succeeded", ok, ok ? `${r.addSec.toFixed(0)}s` : r.addSteps.split("\n").pop());
      if (!ok) throw new Error("add failed");
      r.transcriptSource = (/(\d+) segments \((\w+)\)/.exec(r.addSteps) || []).slice(1).join(" segments via ");
      fs.writeFileSync(prev, JSON.stringify({ addSteps: r.addSteps, addSec: r.addSec, transcriptSource: r.transcriptSource }));
      await page.getByRole("link", { name: "open the editor" }).click();
    });

    // ── 2. Open the editor from the success link ──
    await page.waitForURL(/\/edit\?v=/);
    await page.getByTestId("transcript-line").first().waitFor({ timeout: 60000 });
    await page.waitForFunction(() => /Total: (?!0:00$)\d/.test(document.body.innerText.match(/Total: [\d:]+/)?.[0] || ""), null, { timeout: 60000 });
    const total = await page.locator("text=/Total: /").innerText().catch(() => "");
    r.durationSec = parseClock(total.replace("Total:", ""));
    check("editor: opened from link with transcript", true, `${await page.getByTestId("transcript-line").count()} lines, ${total}`);
    await snap("editor");

    // ── 3. Choose the range with this case's control ──
    if (c.method === "typed") {
      await typeTime("Start", c.start);
      await typeTime("End", c.start + c.len);
      const s = await sel();
      check("typed Start/End set the range", s && Math.abs(s.in - c.start) < 0.01 && Math.abs(s.out - (c.start + c.len)) < 0.01, JSON.stringify(s));
    } else if (c.method === "transcript-click") {
      const lines = page.getByTestId("transcript-line");
      const starts = await lines.evaluateAll((els) => els.map((e) => Number(e.dataset.start)));
      const iA = starts.findIndex((s) => s >= c.start);
      await lines.nth(iA).click();
      let s = await sel();
      check("first transcript click selects 10 s from that line", s && Math.abs(s.in - starts[iA]) < 0.01 && Math.abs(s.out - s.in - 10) < 0.01, JSON.stringify(s));
      const iB = starts.findIndex((t) => t >= c.start + c.len);
      await lines.nth(iB).scrollIntoViewIfNeeded();
      await lines.nth(iB).click();
      s = await sel();
      check("later transcript click moves End to that line", s && Math.abs(s.out - starts[iB]) < 0.01 && Math.abs(s.in - starts[iA]) < 0.01, JSON.stringify(s));
    } else if (c.method === "search") {
      const box = page.getByRole("textbox", { name: "Search transcript" });
      await box.fill(c.query);
      await page.waitForTimeout(400);
      await box.press("Enter");
      const hit = page.locator("[data-testid=transcript-line]", { hasText: new RegExp(c.query, "i") }).nth(1);
      const hitStart = Number(await hit.getAttribute("data-start"));
      await hit.click();
      await typeTime("End", hitStart + c.len);
      const s = await sel();
      check("search hit click sets Start, typed End sets length", s && Math.abs(s.in - hitStart) < 0.01 && Math.abs(s.out - hitStart - c.len) < 0.01, `query "${c.query}" → ${JSON.stringify(s)}`);
      await page.getByRole("button", { name: "Clear transcript search" }).click().catch(() => {});
    } else if (c.method === "nudge") {
      await typeTime("Start", c.start);
      await typeTime("End", c.start + c.len);
      const before = await sel();
      for (const [name, n] of [["Move Start forward two frames", 3], ["Move Start back two frames", 1], ["Move End forward two frames", 2], ["Move End back two frames", 1]]) {
        for (let i = 0; i < n; i++) await page.getByRole("button", { name }).click();
      }
      const s = await sel();
      const step = 2 / 30;
      check("±2-frame buttons move Start/End by 2/30 s each", s && Math.abs(s.in - (before.in + 2 * step)) < 0.002 && Math.abs(s.out - (before.out + step)) < 0.002, `${JSON.stringify(before)} → ${JSON.stringify(s)}`);
    } else if (c.method === "drag") {
      await typeTime("Start", c.start);
      await typeTime("End", c.start + 120);
      // The timeline opens zoomed, so measure seconds-per-pixel from the two handles.
      const hx = async (h) => { const b = await page.locator(`[data-handle=${h}]`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      const s0 = await hx("start"), e0 = await hx("end");
      const secPerPx = 120 / (e0.x - s0.x);
      const drag = async (h, from, dx) => {
        await page.mouse.move(from.x, from.y); await page.mouse.down();
        await page.mouse.move(from.x + dx, from.y, { steps: 15 }); await page.mouse.up();
        await page.waitForTimeout(300);
      };
      const endDx = Math.round((c.len - 120) / secPerPx), startDx = -Math.round(30 / secPerPx);
      await drag("end", e0, endDx);
      await drag("start", await hx("start"), startDx);
      const s = await sel();
      const tol = 3 * secPerPx + 0.5;
      check("dragging handles moves Start/End", s && Math.abs(s.out - (c.start + 120 + endDx * secPerPx)) < tol && Math.abs(s.in - (c.start + startDx * secPerPx)) < tol,
        `end dragged ${endDx}px, start ${startDx}px → ${JSON.stringify(s)} (1px≈${secPerPx.toFixed(2)}s, expected ≈${(c.start + startDx * secPerPx).toFixed(1)}–${(c.start + 120 + endDx * secPerPx).toFixed(1)})`);
      // Snap to the intended length with typed values so the export length is exact.
      await typeTime("Start", c.start);
      await typeTime("End", c.start + c.len);
    } else if (c.method === "clip-finder") {
      await page.getByRole("button", { name: "Clip Finder", exact: true }).click();
      await page.getByRole("button", { name: /best snippets/i }).click();
      const first = page.locator("[data-testid=editor-side-pane] div.cursor-pointer").filter({ hasText: /\d+:\d{2} – \d+:\d{2}/ }).first();
      await first.waitFor({ timeout: 180000 });
      await snap("clip-finder-results");
      const label = await first.innerText();
      await first.click();
      await page.waitForTimeout(500);
      const s = await sel();
      r.clipFinderLabel = label.slice(0, 200);
      check("Clip Finder result becomes the range", s && s.out > s.in, `${label.split("\n")[0]} → ${JSON.stringify(s)}`);
      if (s && s.out - s.in > 300) { await typeTime("End", s.in + 300); }
      await page.getByRole("button", { name: "Transcript", exact: true }).click();
    }

    const range = await sel();
    r.range = range;
    await snap("range");

    // ── 4. Extra controls ──
    if (c.extra.includes("play-pause")) {
      const a = await now();
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await page.waitForTimeout(4000);
      const b = await now();
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.waitForTimeout(1500);
      const c2 = await now();
      await page.waitForTimeout(1500);
      const d = await now();
      check("Play advances the playhead, Pause stops it", b > a && d === c2, `${a}→${b}s playing, ${c2}→${d}s paused`);
    }
    if (c.extra.includes("spacebar")) {
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      const a = await now();
      await page.keyboard.press("Space");
      await page.waitForTimeout(3500);
      const b = await now();
      await page.keyboard.press("Space");
      await page.waitForTimeout(1500);
      const c2 = await now();
      await page.waitForTimeout(2000);
      const d = await now();
      check("Spacebar plays and pauses", b > a && d === c2, `${a}→${b}s after Space, ${c2}→${d}s after second Space`);
    }
    if (c.extra.includes("speed")) {
      for (let i = 0; i < 3; i++) await page.locator("button", { hasText: "»" }).click();
      const rate = await page.locator("button", { hasText: "«" }).locator("xpath=following-sibling::span[1]").innerText();
      await page.getByRole("button", { name: "From Start", exact: true }).click();
      await page.waitForTimeout(1500);
      const a = await now();
      await page.waitForTimeout(6000);
      const b = await now();
      r.speedSample = { rate, videoSec: b - a, wallSec: 6 };
      await page.getByRole("button", { name: "Pause", exact: true }).click().catch(() => {});
      check("speed » raises the rate and playback runs faster", rate === "2x" && b - a >= 9, `rate ${rate}, ${b - a}s of video in 6 s`);
      for (let i = 0; i < 3; i++) await page.locator("button", { hasText: "«" }).click();
    }
    if (c.extra.includes("from-start")) {
      await page.getByRole("button", { name: "From Start", exact: true }).click();
      await page.waitForTimeout(2000);
      const t = await now();
      await page.getByRole("button", { name: "Pause", exact: true }).click().catch(() => {});
      check("From Start plays from the clip's Start", t >= Math.floor(range.in) && t <= range.in + 4, `start ${range.in}, playhead ${t}`);
    }
    if (c.extra.includes("last-3s")) {
      await page.getByRole("button", { name: "Last 3s", exact: true }).click();
      await page.waitForTimeout(1200);
      const t = await now();
      await page.waitForTimeout(4000);
      const t2 = await now();
      check("Last 3s plays the end of the clip and stops at End", t >= Math.floor(range.out - 3.5) && t <= range.out && t2 <= Math.ceil(range.out) + 1, `end ${range.out}, playhead ${t} then ${t2}`);
    }
    if (c.extra.includes("follow-toggle")) {
      const box = page.getByRole("checkbox", { name: "Follow playback" });
      const before = await box.isChecked();
      await box.click();
      await page.reload({ waitUntil: "networkidle" });
      await page.getByTestId("transcript-line").first().waitFor({ timeout: 60000 });
      const after = await page.getByRole("checkbox", { name: "Follow playback" }).isChecked();
      check("Follow playback toggle is remembered after reload", before !== after, `${before} → ${after}`);
      await page.getByRole("checkbox", { name: "Follow playback" }).click();
      // reload cleared the range: restore it
      await typeTime("Start", range.in);
      await typeTime("End", range.out);
    }
    if (c.extra.includes("zoom")) {
      const label = page.locator("span", { hasText: /^\d+x$/ }).first();
      const z0 = await label.innerText();
      for (let i = 0; i < 4; i++) await page.locator("button", { hasText: /^\+$/ }).click();
      const z1 = await label.innerText();
      await snap("zoomed");
      for (let i = 0; i < 4; i++) await page.locator("button", { hasText: /^-$/ }).click();
      check("zoom + and - change the timeline zoom", z0 !== z1 && (await label.innerText()) === z0, `${z0} → ${z1} → back`);
    }
    if (c.extra.includes("over-limit")) {
      await typeTime("End", range.in + 12 * 60);
      const alert = await page.locator("[role=alert]", { hasText: /maximum/i }).innerText().catch(() => "");
      const disabled = !(await page.getByTestId("export-snippet").isEnabled());
      check("a 12-minute range is rejected and Export is disabled", alert && disabled, alert);
      await snap("over-limit");
      await typeTime("End", range.out);
    }

    const finalRange = await sel();
    r.range = finalRange;
    const len = finalRange.out - finalRange.in;
    check("range ≤ 5 min before export", len > 0 && len <= 300.01, `${finalRange.in.toFixed(2)}–${finalRange.out.toFixed(2)} (${len.toFixed(2)} s)`);

    // ── 5. Export and download ──
    if (process.env.QA_SKIP_EXPORT) throw Object.assign(new Error("export skipped (QA_SKIP_EXPORT)"), { skip: true });
    await page.getByTestId("export-estimate").waitFor({ timeout: 20000 }).catch(() => {});
    r.estimate = await page.getByTestId("export-estimate").innerText().catch(() => null);
    const t0 = Date.now();
    const dlP = page.waitForEvent("download", { timeout: 25 * 60000 });
    await page.getByTestId("export-snippet").click();
    await page.waitForTimeout(3000);
    await snap("exporting");
    const dl = await dlP;
    r.exportSec = (Date.now() - t0) / 1000;
    r.filename = dl.suggestedFilename();
    await dl.saveAs(path.join(dir, "clip.mp4"));
    await snap("exported");
    check("export downloaded an MP4", fs.statSync(path.join(dir, "clip.mp4")).size > 10000, `${r.filename}, ${(fs.statSync(path.join(dir, "clip.mp4")).size / 1e6).toFixed(1)} MB in ${r.exportSec.toFixed(0)} s (estimate ${r.estimate})`);
  } catch (e) {
    if (e.skip) { console.log(`[${c.id}] ${e.message}`); } else {
    check("run completed", false, e.message.split("\n")[0]); }
    await snap("error");
  }
  r.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(r, null, 2));
  await ctx.close();
  return r;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const queue = [...cases];
  const results = [];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) results.push(await runCase(browser, queue.shift()));
  }));
  await browser.close();
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(results, null, 2));
  const failed = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.id}: ${c.name} — ${c.detail}`));
  console.log(`\n${results.length} cases, ${results.reduce((a, r) => a + r.checks.length, 0)} checks, ${failed.length} failed`);
  failed.forEach((f) => console.log("FAIL " + f));
  process.exit(failed.length ? 1 : 0);
})();
