// Clip Finder ↔ Transcript tab switching keeps Clip Finder's state.
//
//   SITE=https://www.snippysaurus.com [SHARE_URL=<vercel share link for a protected preview>] \
//   PLAYWRIGHT_MODULE=/abs/node_modules/playwright QA_OUT=qa-recordings/x \
//   node scripts/verify-clip-finder-tabs.cjs
//
// Calls the paid /api/clip-finder (several prompts) and exports one short
// clip. Writes QA_OUT/results.json and screenshots; exits nonzero on failure.

const fs = require("fs");
const path = require("path");
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const SITE = (process.env.SITE || "https://www.snippysaurus.com").replace(/\/$/, "");
const OUT = path.resolve(process.env.QA_OUT || ".context/clip-finder-tabs");
const LONG = "wzgkc6Iegx8"; // Connor Leahy, 64 min (the reported case)
const SHORT = "t-GP3mr4s80"; // Curt Jaimungal, 2:42 vertical
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let shot = 0;
const check = (cfg, name, ok, detail) => {
  results.push({ cfg, name, ok: !!ok, detail });
  console.log(`[${cfg}] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

function helpers(p) {
  const tab = (name) => p.getByRole("button", { name, exact: true }).click().then(() => p.waitForTimeout(400));
  const cards = () => p.locator("[data-testid=clip-finder-pane] div.cursor-pointer").filter({ hasText: /\d+:\d{2} – \d+:\d{2}/ });
  const sel = async () => {
    const el = p.getByTestId("segment-active");
    if (!(await el.count())) return null;
    return { in: +(await el.getAttribute("data-in")), out: +(await el.getAttribute("data-out")) };
  };
  const selectionInView = () => p.getByTestId("transcript-scroll").evaluate((c) => {
    const g = c.querySelector("[data-testid=transcript-line].bg-green-50");
    if (!g) return { visible: false, reason: "no highlighted line" };
    const cr = c.getBoundingClientRect(), gr = g.getBoundingClientRect();
    return { firstLine: +g.dataset.start, visible: gr.top >= cr.top - 2 && gr.bottom <= cr.bottom + 2 };
  });
  const snap = (label) => p.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, "0")}-${label}.png`) });
  const open = async (url) => {
    await p.goto(url, { waitUntil: "domcontentloaded" });
    await p.getByTestId("transcript-line").first().waitFor({ timeout: 90000 });
  };
  const runPrompt = async (label) => {
    const before = await cards().count();
    await p.getByRole("button", { name: label }).click();
    await p.waitForFunction((n) => document.querySelectorAll("[data-testid=clip-finder-pane] div.cursor-pointer").length > n, before, { timeout: 180000 });
    await p.waitForTimeout(800);
  };
  return { tab, cards, sel, selectionInView, snap, open, runPrompt };
}

async function desktop(browser) {
  const cfg = "chromium-desktop";
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  if (process.env.SHARE_URL) await p.goto(process.env.SHARE_URL, { waitUntil: "domcontentloaded" });
  const h = helpers(p);

  // 1. The reported case: link with a range → Clip Finder prompt → pick → Transcript → back.
  await h.open(`${SITE}/edit?v=${LONG}&start=2408&end=2454.999999999999`);
  await h.tab("Clip Finder");
  await h.runPrompt(/AI safety quotes/i);
  const first = await h.cards().allInnerTexts();
  check(cfg, "AI safety quotes prompt returns results", first.length > 0, `${first.length} cards`);
  for (let i = 0; i < first.length; i++) {
    await h.tab("Clip Finder");
    const now = await h.cards().allInnerTexts();
    await h.cards().nth(i).click();
    await p.waitForTimeout(500);
    const r = await h.sel();
    await h.tab("Transcript");
    const v = await h.selectionInView();
    check(cfg, `pick card ${i + 1} → Transcript shows the picked clip`, v.visible && r && Math.abs(v.firstLine - r.in) < 15, { range: r, ...v });
    check(cfg, `card ${i + 1}: results were still there when switching back`, JSON.stringify(now) === JSON.stringify(first), `${now.length}/${first.length}`);
  }
  await h.tab("Clip Finder");
  const picked = await h.cards().last().evaluate((e) => e.className.includes("border-green-600"));
  check(cfg, "last picked card is still highlighted after the round trips", picked);
  await h.snap("desktop-results-kept");

  // 2. A second prompt adds to the first; both survive a switch.
  // (the quick-prompt buttons only show before the first prompt)
  await p.getByPlaceholder("Find clips about...").fill("the best moments");
  await p.getByPlaceholder("Find clips about...").press("Enter");
  await p.waitForFunction((n) => (document.querySelector("[data-testid=clip-finder-pane]")?.textContent?.match(/Clip Finder · \d+ snippet/g) || []).length > n, 1, { timeout: 180000 });
  await p.waitForTimeout(800);
  const two = await p.getByTestId("clip-finder-pane").innerText();
  await h.tab("Transcript");
  await h.tab("Clip Finder");
  check(cfg, "two rounds of results survive a switch", (await p.getByTestId("clip-finder-pane").innerText()) === two);

  // 3. Clip Finder's scroll position is restored.
  const body = p.locator("[data-testid=clip-finder-pane] .overflow-y-auto").first();
  await body.evaluate((b) => { b.scrollTop = Math.max(0, Math.floor((b.scrollHeight - b.clientHeight) / 3)); b.dispatchEvent(new Event("scroll")); });
  await p.waitForTimeout(300);
  const st = await body.evaluate((b) => b.scrollTop);
  await h.tab("Transcript");
  await h.tab("Clip Finder");
  const st2 = await body.evaluate((b) => b.scrollTop);
  check(cfg, "Clip Finder scroll position restored after switching", Math.abs(st - st2) <= 2, `${st} → ${st2}`);

  // 4. Typed query sent, switch away at once, come back after it finishes.
  const blocks = await p.getByTestId("clip-finder-pane").getByText(/Clip Finder · \d+ snippet/).count();
  await p.getByPlaceholder("Find clips about...").fill("what he says about governments and regulation");
  await p.getByPlaceholder("Find clips about...").press("Enter");
  await p.waitForTimeout(300);
  await h.tab("Transcript");
  await p.waitForFunction((n) => {
    const pane = document.querySelector("[data-testid=clip-finder-pane]");
    return (pane?.textContent?.match(/Clip Finder · \d+ snippet/g) || []).length > n;
  }, blocks, { timeout: 180000 });
  await h.tab("Clip Finder");
  // textContent, not innerText: the heading is CSS-uppercased on screen.
  const txt = await p.getByTestId("clip-finder-pane").evaluate((e) => e.textContent);
  check(cfg, "request finished while on Transcript: its results show on return", txt.includes("what he says about governments") && (txt.match(/Clip Finder · \d+ snippet/g) || []).length > blocks);
  await h.snap("desktop-request-while-away");

  // 5. Transcript search text survives switching to Clip Finder and back.
  await h.tab("Transcript");
  await p.getByRole("textbox", { name: "Search transcript" }).fill("superintelligence");
  await h.tab("Clip Finder");
  await h.tab("Transcript");
  check(cfg, "Transcript search text survives the round trip", (await p.getByRole("textbox", { name: "Search transcript" }).inputValue()) === "superintelligence");
  await p.getByRole("button", { name: "Clear transcript search" }).click();

  // 6. Follow playback still tracks the spoken line while Transcript is shown.
  await p.getByRole("button", { name: "From Start", exact: true }).click();
  await p.waitForTimeout(5000);
  const cur = await p.getByTestId("transcript-scroll").evaluate((c) => {
    const l = c.querySelector("[data-testid=transcript-line][aria-current=true]");
    if (!l) return null;
    const cr = c.getBoundingClientRect(), lr = l.getBoundingClientRect();
    return { line: +l.dataset.start, visible: lr.top >= cr.top - 2 && lr.bottom <= cr.bottom + 2 };
  });
  await p.getByRole("button", { name: "Pause", exact: true }).click().catch(() => {});
  check(cfg, "Follow playback keeps the current line in view", cur && cur.visible, cur);

  // 7. Export the last Clip Finder pick (shortened to 20 s) and download it.
  await h.tab("Clip Finder");
  await h.cards().first().click();
  await p.waitForTimeout(500);
  const r = await h.sel();
  const end = p.getByRole("textbox", { name: "End", exact: true });
  await end.fill(String(r.in + 20));
  await end.press("Enter");
  await h.tab("Transcript");
  await h.tab("Clip Finder");
  const dl = p.waitForEvent("download", { timeout: 15 * 60000 });
  await p.getByTestId("export-snippet").click();
  const d = await dl;
  const file = path.join(OUT, "export.mp4");
  await d.saveAs(file);
  check(cfg, "export of a Clip Finder pick downloads after tab switches", fs.statSync(file).size > 10000, `${d.suggestedFilename()} ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
  await ctx.close();
}

async function fresh(browser) {
  // 8. No range in the link, short vertical video.
  const cfg = "chromium-desktop short video, no range";
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  if (process.env.SHARE_URL) await p.goto(process.env.SHARE_URL, { waitUntil: "domcontentloaded" });
  const h = helpers(p);
  await h.open(`${SITE}/edit?v=${SHORT}`);
  await h.tab("Clip Finder");
  const reqs = [];
  p.on("request", (q) => { if (q.url().includes("/api/clip-finder")) reqs.push(JSON.parse(q.postData() || "{}").transcript?.length); });
  p.on("response", async (q) => { if (q.url().includes("/api/clip-finder")) reqs.push(`HTTP ${q.status()} ${(await q.text().catch(() => "")).slice(0, 200)}`); });
  try { await h.runPrompt(/Best snippets/i); }
  catch (e) { await h.snap("fresh-timeout"); throw new Error(`no cards; clip-finder calls: ${JSON.stringify(reqs)}; pane: ${(await p.getByTestId("clip-finder-pane").innerText()).slice(0, 300)}`); }
  const a = await h.cards().allInnerTexts();
  await h.cards().first().click();
  await p.waitForTimeout(400);
  const r = await h.sel();
  await h.tab("Transcript");
  const v = await h.selectionInView();
  await h.tab("Clip Finder");
  check(cfg, "results kept and pick shown in Transcript", JSON.stringify(await h.cards().allInnerTexts()) === JSON.stringify(a) && v.visible && r, { cards: a.length, range: r, ...v });
  await ctx.close();
}

async function phone() {
  // 9. iPhone (WebKit): same round trip on the stacked layout.
  const cfg = "iphone-webkit";
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const p = await ctx.newPage();
  if (process.env.SHARE_URL) await p.goto(process.env.SHARE_URL, { waitUntil: "domcontentloaded" });
  const h = helpers(p);
  await h.open(`${SITE}/edit?v=${LONG}&start=2408&end=2455`);
  await h.tab("Clip Finder");
  await h.runPrompt(/Best snippets/i);
  const a = await h.cards().allInnerTexts();
  await h.cards().nth(Math.min(1, a.length - 1)).click();
  await p.waitForTimeout(400);
  await h.tab("Transcript");
  const v = await h.selectionInView();
  await h.snap("iphone-transcript");
  await h.tab("Clip Finder");
  check(cfg, "results kept and pick shown in Transcript", JSON.stringify(await h.cards().allInnerTexts()) === JSON.stringify(a) && v.visible, { cards: a.length, ...v });
  await h.snap("iphone-clip-finder");
  await browser.close();
}

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const only = (process.env.QA_ONLY || "").split(",").filter(Boolean);
  for (const [name, fn] of [["desktop", () => desktop(browser)], ["fresh", () => fresh(browser)], ["phone", phone]]) {
    if (only.length && !only.includes(name)) continue;
    try { await fn(); } catch (e) { check(name, "run completed", false, e.message.split("\n")[0]); }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ site: SITE, at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
