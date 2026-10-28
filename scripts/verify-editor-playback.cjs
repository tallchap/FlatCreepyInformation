// Live playback verification; mobile/tablet devices are emulated, not physical.
// PREVIEW_URL=... PLAYWRIGHT_MODULE=/path/to/playwright node scripts/verify-editor-playback.cjs
const { chromium, firefox, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = process.env.PREVIEW_URL || "http://localhost:4786";
const out = path.resolve(process.env.QA_OUT || ".context/playback-position");
fs.mkdirSync(out, { recursive: true });
const matrix = [
  ["chromium-desktop", chromium, { viewport: { width: 1440, height: 1000 } }],
  ["firefox-desktop", firefox, { viewport: { width: 1440, height: 1000 } }],
  ["webkit-desktop", webkit, { viewport: { width: 1440, height: 1000 } }],
  ["android", chromium, devices["Pixel 7"]],
  ["iphone", webkit, devices["iPhone 13"]],
  ["ipad", webkit, devices["iPad (gen 7)"]],
];
const results = [];
const timeValue = (text) => text.split(":").reduce((a, n) => a * 60 + Number(n), 0);
async function playerState(p) {
  return p.evaluate(() => {
    const player = window.YT.get(document.querySelector("#clip-player iframe").id);
    return { time: player.getCurrentTime(), duration: player.getDuration(), state: player.getPlayerState() };
  });
}
async function ready(p) {
  await p.getByRole("checkbox", { name: "Follow playback" }).waitFor({ timeout: 60000 });
  await p.waitForFunction(() => {
    const frame = document.querySelector("#clip-player iframe");
    return frame && window.YT?.get(frame.id)?.getDuration?.() > 0;
  }, {}, { timeout: 60000 });
}
async function currentVisible(p) {
  await p.waitForFunction(() => {
    const line = document.querySelector('[data-testid="transcript-line"][aria-current="true"]');
    const container = document.querySelector('[data-testid="transcript-scroll"]');
    if (!line || !container) return false;
    const a = line.getBoundingClientRect(), b = container.getBoundingClientRect();
    return a.top >= b.top - 2 && a.bottom <= b.bottom + 2;
  });
}
async function readout(p) {
  const actual = await playerState(p);
  const timeline = await p.getByTestId("timeline-position").getByTestId("current-time").textContent();
  assert.equal(await p.getByTestId("player-position").count(), 0);
  assert.equal(await p.getByText("Video position", { exact: true }).count(), 0);
  assert(Math.abs(timeValue(timeline) - actual.time) < 1.2, `Readout ${timeline} differs from player ${actual.time}`);
  return { display: timeline, actual: actual.time };
}
async function fits(p) {
  assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal overflow");
}
async function aligned(p) {
  await p.waitForFunction(() => {
    const left = document.querySelector('[data-testid="editor-video-column"]');
    const right = document.querySelector('[data-testid="editor-side-pane"]');
    if (!left || !right) return false;
    const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
    return innerWidth >= 1024
      ? Math.abs(a.top - b.top) < 2 && Math.abs(a.bottom - b.bottom) < 2 && b.left - a.right <= 13
      : b.top >= a.bottom && b.top - a.bottom <= 13;
  });
  const pane = await p.getByTestId("editor-side-pane").boundingBox();
  const input = p.getByPlaceholder("Find clips about...");
  if (await input.isVisible()) {
    const box = await input.boundingBox();
    assert(box.y + box.height <= pane.y + pane.height, "Clip Finder input must stay inside the aligned pane");
  }
  await fits(p);
}
async function seek(p, seconds) {
  const track = p.getByTestId("timeline-track");
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  const { duration } = await playerState(p);
  await track.click({ position: { x: box.width * seconds / duration, y: box.height / 2 } });
  await p.waitForFunction(({ target, tolerance }) => {
    const player = window.YT.get(document.querySelector("#clip-player iframe").id);
    return Math.abs(player.getCurrentTime() - target) < tolerance;
  }, { target: seconds, tolerance: Math.max(2, duration / box.width * 2) });
  await p.waitForTimeout(250);
}
(async () => {
  for (const [name, engine, options] of matrix) {
    if (process.env.QA_DEVICE && !process.env.QA_DEVICE.split(",").includes(name)) continue;
    const b = await engine.launch();
    const p = await b.newPage(options);
    p.setDefaultTimeout(20000);
    const errors = [], checks = [];
    p.on("pageerror", e => errors.push({ url: p.url(), message: e.message }));
    const shot = async suffix => p.screenshot({ path: path.join(out, `${name}-${suffix}.png`), animations: "disabled" });
    try {
      await p.goto(base + "/edit?v=CRraHg4Ks_g&start=60&end=76", { waitUntil: "domcontentloaded" });
      await ready(p);
      for (const tab of ["Clip Finder", "Transcript"]) {
        await p.getByRole("button", { name: tab, exact: true }).click();
        await aligned(p);
        await shot(tab.toLowerCase().replace(" ", "-"));
      }
      await p.getByRole("checkbox", { name: "Follow playback" }).waitFor();
      checks.push({ name: "player and side pane align in both tabs; mobile stack and input fit" });
      const saved = p.getByTestId("ready-made-snippets");
      await saved.waitFor({ timeout: 60000 });
      assert.equal(await saved.getByTestId("snippet-chooser").count(), 0);
      assert.equal(await saved.getByRole("heading", { name: "Ready-Made Snippet", exact: true }).count(), 1);
      assert.equal(await saved.getByRole("button", { name: /Snippets.*1 snippet/ }).count(), 0);
      await saved.scrollIntoViewIfNeeded(); await shot("single-snippet");
      checks.push({ name: "one saved snippet has no duplicate chooser or accordion header" });
      const follow = p.getByRole("checkbox", { name: "Follow playback" });
      assert(await follow.isChecked(), "Following defaults on");
      await p.locator("#clip-player").scrollIntoViewIfNeeded();
      await p.getByRole("button", { name: "From Start", exact: true }).click();
      await p.waitForFunction(() => window.YT.get(document.querySelector("#clip-player iframe").id).getCurrentTime() >= 63);
      await p.getByRole("button", { name: "Pause", exact: true }).click();
      await currentVisible(p);
      checks.push({ name: "real playback updates the compact timeline timestamp and highlighted line", ...await readout(p) });
      await p.locator("#clip-player").scrollIntoViewIfNeeded();
      await fits(p); await shot("playing");

      // Zoom out so pointer seeking uses the whole video, independently of clip bounds.
      const zoomOut = p.getByRole("button", { name: "-", exact: true });
      for (let i = 0; i < 4; i++) await zoomOut.click();
      await seek(p, 301);
      await currentVisible(p);
      checks.push({ name: "timeline seek shows absolute full-video time", ...await readout(p) });
      await p.getByTestId("timeline-position").scrollIntoViewIfNeeded(); await shot("timeline");

      await follow.uncheck();
      await p.getByTestId("transcript-scroll").evaluate(e => e.scrollTo({ top: 0, behavior: "instant" }));
      await seek(p, 601);
      await p.waitForTimeout(500);
      // Allow sub-line scroll anchoring; following would jump thousands of pixels.
      assert((await p.getByTestId("transcript-scroll").evaluate(e => e.scrollTop)) < 8);
      // The player shield provides the same click/tap used while watching the video.
      await p.getByTestId("yt-shield").click();
      const before = (await playerState(p)).time;
      await p.waitForFunction(t => window.YT.get(document.querySelector("#clip-player iframe").id).getCurrentTime() > t + 4, before);
      await p.getByTestId("yt-shield").click();
      assert((await p.getByTestId("transcript-scroll").evaluate(e => e.scrollTop)) < 8, "Unchecked transcript must stay where the reader left it");
      checks.push({ name: "follow off preserves reader position during seeks and playback", ...await readout(p) });
      await follow.scrollIntoViewIfNeeded(); await shot("follow-off");
      await follow.check();
      await currentVisible(p);
      checks.push({ name: "re-enabling follow catches up to current spoken line" });
      await shot("follow-on");

      const search = p.getByRole("textbox", { name: "Search transcript", exact: true });
      await search.fill("AGI");
      await p.waitForTimeout(1500);
      const searchScroll = await p.getByTestId("transcript-scroll").evaluate(e => e.scrollTop);
      await seek(p, 850);
      await p.waitForTimeout(500);
      assert(Math.abs(await p.getByTestId("transcript-scroll").evaluate(e => e.scrollTop) - searchScroll) < 2, "Search must retain scroll control while follow is checked");
      await p.getByRole("button", { name: "Clear transcript search" }).click();
      await currentVisible(p);
      checks.push({ name: "search pauses following; clearing resumes it" });

      await follow.uncheck();
      await p.reload({ waitUntil: "domcontentloaded" }); await ready(p);
      assert.equal(await follow.isChecked(), false, "Follow preference survives reload");
      await follow.focus(); await follow.press("Space");
      assert(await follow.isChecked(), "Checkbox works with keyboard");
      await currentVisible(p);
      checks.push({ name: "saved preference and keyboard toggle" });
      await fits(p);
      if (name === "chromium-desktop") {
        await p.getByTitle("Fullscreen with overlay").click();
        await p.waitForFunction(() => !!document.fullscreenElement);
        assert.equal(await p.getByTestId("player-position").count(), 0);
        await shot("fullscreen");
        await p.evaluate(() => document.exitFullscreen());
        await p.setViewportSize({ width: 320, height: 900 });
        await p.getByTestId("timeline-position").scrollIntoViewIfNeeded();
        await fits(p); await shot("320px");
        assert((await p.getByTestId("timeline-position").boundingBox()).height <= 36);
        checks.push({ name: "unobstructed fullscreen and compact 320px timestamp" });
      }
      await p.goto(base + "/edit?v=UWh1MIMQd1Y", { waitUntil: "domcontentloaded" });
      const chooser = p.getByTestId("snippet-chooser");
      await chooser.waitFor({ timeout: 60000 });
      const cards = chooser.locator("div.flex-shrink-0");
      assert.equal(await cards.count(), 6);
      const media = p.getByTestId("ready-made-snippets").locator("video");
      const firstSource = await media.getAttribute("src");
      await cards.nth(1).click();
      assert.notEqual(await media.getAttribute("src"), firstSource);
      assert.equal(await p.getByTestId("ready-made-snippets").getByRole("link", { name: "Download Snippet" }).getAttribute("href"), await media.getAttribute("src"));
      await media.evaluate(v => { v.muted = true; return v.play(); });
      await p.waitForFunction(() => document.querySelector('[data-testid="ready-made-snippets"] video')?.currentTime > 0);
      await fits(p); await p.getByTestId("ready-made-snippets").scrollIntoViewIfNeeded(); await shot("multiple-snippets");
      checks.push({ name: "multiple snippets retain their chooser, selected source, playback and download link" });
      assert.deepEqual(errors, []);
      results.push({ name, pass: true, checks, errors });
      console.log(`PASS ${name} (${checks.length} checks)`);
    } catch (e) {
      results.push({ name, pass: false, checks, error: e.stack, errors });
      console.error(`FAIL ${name}: ${e.stack}`);
      await shot("failure").catch(() => {});
    } finally {
      await b.close();
      fs.writeFileSync(path.join(out, "verification.json"), JSON.stringify({ time: new Date().toISOString(), base, devices: "Desktop engines and emulated mobile/tablet; no physical devices", results }, null, 2));
    }
  }
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
})();
