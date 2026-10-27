// Live full-video journeys on emulated devices, not physical phones.
// Boundary tests separately inject a transcript outage and deterministic Clip Finder suggestions.
// PLAYWRIGHT_MODULE=/path/to/playwright PREVIEW_URL=http://localhost:4786 node scripts/verify-full-video-editor.cjs
const { chromium, webkit, devices } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const base = process.env.PREVIEW_URL || "http://localhost:4786";
const out = path.resolve(process.env.QA_OUT || ".context/single-clip");
fs.mkdirSync(out, { recursive: true });
const results = [];
const failures = [];
const touchContexts = new WeakMap();
async function hydrated(p, selector) {
  await p.waitForFunction((sel) => {
    const e = document.querySelector(sel);
    return e && Object.keys(e).some((k) => k.startsWith("__reactProps$"));
  }, selector);
}
async function activate(locator) {
  const touch = touchContexts.get(locator.page().context());
  if (touch) await locator.tap();
  else await locator.click();
}
async function shot(p, name) {
  await p.screenshot({
    path: path.join(out, name + ".png"),
    animations: "disabled",
    timeout: 10000,
  });
}
async function fits(p) {
  assert(
    await p.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Horizontal overflow at " + p.url(),
  );
}
async function editor(p, href) {
  await p.waitForURL("**/edit?**", { waitUntil: "domcontentloaded" });
  await p.getByTestId("transcript-line").first().waitFor({ timeout: 60000 });
  await p
    .locator('iframe[src*="youtube.com/embed/"]')
    .waitFor({ timeout: 60000 });
  const params = new URL(href, base).searchParams;
  const start = params.get("start");
  if (start !== null)
    await p.waitForFunction(
      (s) =>
        JSON.parse(
          document.querySelector("[data-testid=segment-list]").dataset.segments,
        )[0]?.in === Number(s),
      start,
    );
  assert.equal(
    await p.getByRole("button", { name: /^(Add segment|Play all)$/ }).count(),
    0,
  );
  assert(
    await p
      .getByRole("textbox", { name: "Search transcript", exact: true })
      .isVisible(),
  );
  if (start !== null)
    await p.waitForFunction(() => {
      const e = document.querySelector(
        "[data-testid=transcript-line].bg-green-50",
      );
      if (!e) return false;
      const r = e.getBoundingClientRect(),
        c = e.parentElement.getBoundingClientRect();
      return r.top >= c.top - 2 && r.top < c.bottom;
    });
  await fits(p);
  return {
    url: p.url(),
    ranges: JSON.parse(
      await p.getByTestId("segment-list").getAttribute("data-segments"),
    ),
  };
}
async function openEditor(p, link) {
  const href = await link.getAttribute("href");
  assert(href?.startsWith("/edit?"));
  const popup = p.waitForEvent("popup");
  await link.click();
  const q = await popup;
  const evidence = await editor(q, href);
  return { q, evidence };
}
async function run(name, engine, options, flow) {
  if (process.env.QA_DEVICE && !name.includes(process.env.QA_DEVICE)) return;
  if (process.env.QA_LAYOUT === "desktop") {
    engine = chromium;
    options = { viewport: { width: 1440, height: 1000 } };
  }
  if (process.env.QA_LAYOUT === "phone") {
    engine = webkit;
    options = { ...devices["iPhone 13"] };
  }
  const browser = await engine.launch();
  const context = await browser.newContext(options);
  touchContexts.set(context, !!options.hasTouch);
  const p = await context.newPage();
  p.setDefaultTimeout(20000);
  const errors = [];
  context.on("page", (q) => q.on("pageerror", (e) => errors.push(e.message)));
  p.on("pageerror", (e) => errors.push(e.message));
  try {
    await flow(p, context);
    assert.deepEqual(errors, []);
    results.push({ name, pass: true, errors });
    console.log("PASS " + name);
  } catch (e) {
    failures.push({ name, error: e.stack });
    results.push({ name, pass: false, error: String(e), errors });
    console.log("FAIL " + name + " " + e);
    await shot(p, name + "-failure").catch(() => {});
  } finally {
    await browser.close();
    fs.writeFileSync(
      path.join(out, "workflow-results.json"),
      JSON.stringify(
        { time: new Date().toISOString(), base, results, failures },
        null,
        2,
      ),
    );
  }
}
(async () => {
  await run(
    "desktop-home-chat",
    chromium,
    { viewport: { width: 1440, height: 1000 } },
    async (p, context) => {
      await p.goto(base + "/", { waitUntil: "domcontentloaded" });
      await fits(p);
      await hydrated(p, "#clip-prompt");
      await p
        .locator("#clip-prompt")
        .fill(
          "Find one exact Sam Altman quote about AI changing jobs, with video and timestamp.",
        );
      await shot(p, "home-desktop");
      await p.locator("#clip-prompt").press("Enter");
      await p.waitForURL("**/chat", { waitUntil: "domcontentloaded" });
      await p.locator("a[data-video-id]").first().waitFor({ timeout: 90000 });
      const citation = p.locator("a[data-video-id]").first();
      const href = await citation.getAttribute("href");
      await citation.click();
      const snip = p.getByRole("link", { name: "Snip It", exact: true });
      await snip.waitFor();
      assert.equal(await snip.getAttribute("href"), href);
      await fits(p);
      await shot(p, "chat-desktop");
      const { q, evidence } = await openEditor(p, snip);
      await shot(q, "editor-desktop");
      results.push({
        name: "homepage → live chat → preview → editor",
        ...evidence,
        pass: true,
      });
      await q.close();
      if (!touchContexts.get(context)) {
        const pop = context.waitForEvent("page");
        await citation.click({ button: "middle" });
        const direct = await pop;
        await editor(direct, href);
        await direct.close();
      } else {
        await p
          .getByRole("button", { name: "Back to chat", exact: true })
          .click();
        await citation.click();
        assert.equal(await snip.getAttribute("href"), href);
      }
    },
  );
  await run(
    "android-search",
    chromium,
    { ...devices["Pixel 7"] },
    async (p) => {
      await p.goto(base + "/search", { waitUntil: "domcontentloaded" });
      await hydrated(p, "#searchQuery");
      await p.locator("#searchQuery").fill("AGI");
      await p.locator("#speakerQuery").fill("Demis Hassabis");
      await p
        .getByRole("button", { name: "Search Videos", exact: true })
        .click();
      await p
        .getByText(/Found .* matching instances/)
        .waitFor({ timeout: 60000 });
      await fits(p);
      await shot(p, "search-android");
      const transcript = p
        .getByRole("link", { name: "Transcript", exact: true })
        .first();
      const href = await transcript.getAttribute("href");
      assert(new URL(href, base).searchParams.has("start"));
      const a = await openEditor(p, transcript);
      results.push({
        name: "Search Transcript → editor",
        ...a.evidence,
        pass: true,
      });
      await a.q.close();
      const match = p.getByRole("button", { name: /^\d+:\d+/ }).first();
      await match.click();
      const snip = p.getByRole("link", { name: "Snip It", exact: true });
      await snip.waitFor();
      const b = await openEditor(p, snip);
      await shot(b.q, "editor-android");
      results.push({
        name: "Search timestamp → preview → editor",
        ...b.evidence,
        pass: true,
      });
      await b.q.getByTestId("clear-selection").click();
      await activate(b.q.getByTestId("transcript-line").nth(2));
      assert.equal(
        JSON.parse(
          await b.q.getByTestId("segment-list").getAttribute("data-segments"),
        ).length,
        1,
      );
      await fits(b.q);
      await b.q.close();
      const title = p
        .locator('a[href^="/edit?"]:not([target="_blank"])')
        .first();
      await title.click();
      await editor(p, base + "/edit?v=x");
    },
  );
  await run("iphone-browse", webkit, { ...devices["iPhone 13"] }, async (p) => {
    await p.goto(base + "/browse", { waitUntil: "domcontentloaded" });
    await p
      .locator('section[aria-label="Speaker directory"][aria-busy=false]')
      .waitFor({ timeout: 60000 });
    await p.getByRole("button", { name: "Find or jump" }).click();
    await p
      .getByRole("textbox", { name: "Find a speaker", exact: true })
      .fill("Demis");
    await p.keyboard.press("Escape");
    const speaker = p
      .getByRole("link")
      .filter({ hasText: "Demis Hassabis" })
      .first();
    await speaker.waitFor({ timeout: 60000 });
    await speaker.click();
    await p
      .getByRole("textbox", { name: "Search videos", exact: true })
      .waitFor({ timeout: 60000 });
    await fits(p);
    await p
      .getByRole("textbox", { name: "Search videos", exact: true })
      .fill("Future of Work");
    const full = p.locator('a[href^="/edit?"]').first();
    await full.waitFor();
    const fullHref = await full.getAttribute("href");
    await shot(p, "browse-iphone");
    await activate(full);
    await editor(p, fullHref);
    await activate(p.getByTestId("transcript-line").nth(2));
    await p
      .getByRole("textbox", { name: "Search transcript", exact: true })
      .fill("AGI");
    await activate(p.getByRole("button", { name: "Next transcript match" }));
    await activate(p.getByRole("button", { name: "Clear transcript search" }));
    await fits(p);
    await shot(p, "editor-iphone");
    await p.goBack({ waitUntil: "domcontentloaded" });
    await activate(p.getByRole("button", { name: /^Snippets / }));
    await p
      .getByRole("textbox", { name: "Search snippets", exact: true })
      .fill("");
    await activate(p.getByRole("button", { name: /Play snippet$/ }).first());
    await p.getByRole("dialog").waitFor();
    const video = p.getByRole("dialog").locator("video");
    await video.waitFor();
    const src = await video.getAttribute("src");
    assert(
      /^https:\/\//.test(src) && !src.includes("youtube.com"),
      "Saved snippet must keep its stored media URL: " + src,
    );
    await video.evaluate((v) => {
      v.muted = true;
      return v.play();
    });
    await p.waitForFunction(
      () => document.querySelector("[role=dialog] video")?.currentTime > 0,
      {},
      { timeout: 30000 },
    );
    assert(
      await p.getByRole("link", { name: "Open clip / download" }).isVisible(),
    );
    await fits(p);
    await shot(p, "snippet-preserved-iphone");
    results.push({
      name: "Saved snippet retains and plays its stored media in the existing view",
      src,
      pass: true,
    });
  });
  await run(
    "tablet-direct-chat",
    chromium,
    { ...devices["iPad (gen 7)"] },
    async (p) => {
      await p.goto(base + "/chat", { waitUntil: "domcontentloaded" });
      await hydrated(p, "#clip-prompt");
      await p
        .locator("#clip-prompt")
        .fill(
          "Find a Sam Altman quote about superintelligence with a video timestamp.",
        );
      await p.locator("#clip-prompt").press("Enter");
      await p.locator("a[data-video-id]").first().waitFor({ timeout: 90000 });
      await activate(p.locator("a[data-video-id]").first());
      const { q, evidence } = await openEditor(
        p,
        p.getByRole("link", { name: "Snip It", exact: true }),
      );
      await shot(q, "editor-tablet");
      results.push({
        name: "Direct chat → citation → editor on tablet",
        ...evidence,
        pass: true,
      });
      await q.getByTestId("clear-selection").click();
      const line = q.getByTestId("transcript-line").nth(3);
      const t = Number(await line.getAttribute("data-start"));
      await line.focus();
      await line.press("Space");
      assert.equal(
        JSON.parse(
          await q.getByTestId("segment-list").getAttribute("data-segments"),
        )[0].in,
        t,
      );
      await q.close();
    },
  );
  await run(
    "editor-boundaries",
    chromium,
    { viewport: { width: 320, height: 900 } },
    async (p) => {
      const id = "CRraHg4Ks_g";
      await p.goto(base + "/video/" + id + "?t=1m2s&end=76", {
        waitUntil: "domcontentloaded",
      });
      await editor(p, base + "/edit?v=" + id + "&start=62");
      await p.goto(base + "/edit?v=" + id + "&seg=60-76,100-120", {
        waitUntil: "domcontentloaded",
      });
      await editor(p, base + "/edit?v=" + id + "&start=60");
      await p.getByText(/only the first range is selected/).waitFor();
      assert.equal(
        JSON.parse(
          await p.getByTestId("segment-list").getAttribute("data-segments"),
        ).length,
        1,
      );
      const rejected = await p.request.post(base + "/api/clip", {
        data: {
          videoId: id,
          segments: [
            { in: 0, out: 10 },
            { in: 20, out: 30 },
          ],
        },
      });
      assert.equal(rejected.status(), 400);
      assert.match((await rejected.json()).error, /exactly one/);
      await p.getByRole("textbox", { name: "End", exact: true }).fill("19:59");
      await p.getByRole("textbox", { name: "End", exact: true }).press("Tab");
      assert.equal(await p.getByTestId("export-snippet").isEnabled(), false);
      await p.getByRole("textbox", { name: "End", exact: true }).fill("1:16");
      await p.getByRole("textbox", { name: "End", exact: true }).press("Tab");
      assert(await p.getByTestId("export-snippet").isEnabled());
      await p
        .getByRole("textbox", { name: "End", exact: true })
        .fill("not a time");
      await p.getByRole("textbox", { name: "End", exact: true }).press("Tab");
      assert.equal(
        await p.getByRole("textbox", { name: "End", exact: true }).inputValue(),
        "1:16.00",
      );
      await p.route("**/api/clip-finder", (route) =>
        route.fulfill({
          json: {
            snippets: [
              { startSec: 20, endSec: 30, description: "First test selection" },
              {
                startSec: 40,
                endSec: 50,
                description: "Second test selection",
              },
            ],
          },
        }),
      );
      await p.getByRole("button", { name: "Clip Finder", exact: true }).click();
      await p.getByRole("button", { name: /Best snippets/ }).click();
      await p.getByText("First test selection", { exact: true }).click();
      await p.getByText("Second test selection", { exact: true }).click();
      assert.deepEqual(
        JSON.parse(
          await p.getByTestId("segment-list").getAttribute("data-segments"),
        ),
        [{ in: 40, out: 50 }],
      );
      await p.getByRole("button", { name: "Transcript", exact: true }).click();
      await p.getByTestId("transcript-line").first().waitFor();
      await p.getByTestId("clear-selection").click();
      assert.equal(await p.getByTestId("export-snippet").isEnabled(), false);
      const line = p.getByTestId("transcript-line").nth(4);
      await line.focus();
      await line.press("Space");
      assert.equal(
        JSON.parse(
          await p.getByTestId("segment-list").getAttribute("data-segments"),
        ).length,
        1,
      );
      await fits(p);
      // Deliberately fail the transcript request, then restore the real endpoint and retry.
      await p.route("**/api/transcript/" + id, (r) =>
        r.fulfill({ status: 503, json: { error: "Injected outage" } }),
      );
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.getByText("The transcript could not be loaded.").waitFor();
      await p.unroute("**/api/transcript/" + id);
      await p.getByRole("button", { name: "Try again", exact: true }).click();
      await p.getByTestId("transcript-line").first().waitFor();
      await fits(p);
      await shot(p, "editor-small-phone");
      await p.goto(base + "/edit?v=invalid", { waitUntil: "domcontentloaded" });
      await p
        .getByText(
          "Open a video from Chat, Search, or Browse to select a clip.",
        )
        .waitFor();
    },
  );
  console.log(
    JSON.stringify({
      passed: results.filter((r) => r.pass).length,
      failed: failures.length,
    }),
  );
  process.exitCode = failures.length ? 1 : 0;
})();
