// Local UX verifier: preview replies are simulated; no paid model calls.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1100, height: 950 } });
  const base = process.env.PREVIEW_URL || "http://127.0.0.1:4784";
  let requests = 0;
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.route("**/api/chat", (r) => {
    requests++;
    return r.abort();
  });
  await p.goto(base + "/preview/chat");
  await p.getByRole("log").waitFor();
  const content = await p.locator("main").innerText();
  assert(!content.includes("Searching Sam Altman"));
  assert(!content.includes("Clip conversation"));
  assert.equal(
    await p.getByRole("complementary", { name: "Chat speakers" }).count(),
    0,
  );
  for (const width of [320, 390, 768, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await p.setViewportSize({ width: 1100, height: 950 });

  assert.equal(
    await p.getByRole("group", { name: "Choose a speaker" }).count(),
    0,
  );
  await p.locator("#clip-prompt").fill("A shorter one");
  await p.locator("#clip-prompt").press("Enter");
  await p
    .getByText(/This is a design preview, so no new search was run/)
    .waitFor();
  assert.equal(requests, 0);
  await p.getByRole("button", { name: "New chat", exact: true }).click();
  await p
    .getByRole("heading", { name: "What would you like to find?" })
    .waitFor();
  assert.equal(await p.getByRole("log").count(), 0);
  assert.equal(
    await p
      .getByRole("button", { name: "AI could change everything", exact: true })
      .count(),
    1,
  );
  await p.route("**/api/speakers", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"speakers":[]}' }),
  );
  await p.getByRole("button", { name: "Change speaker", exact: true }).click();
  await p.getByRole("button", { name: "Sam Altman", exact: true }).click();
  await p.getByRole("button", { name: "Elon Musk (0)", exact: true }).click();
  assert((await p.locator("main").innerText()).includes("Elon Musk said"));
  console.log(
    "PASS Simple chat preview, simulated follow-up, empty state, no paid API requests",
  );
  const mobile = await b.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await mobile.goto(base);
  const stage = mobile.getByRole("group", { name: "Choose a speaker" });
  assert.equal(await stage.getAttribute("data-drag-feel"), "spring");
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox(),
    x = box.x + box.width / 2,
    y = box.y + 130;
  const cdp = await mobile.context().newCDPSession(mobile),
    scroll = await mobile.evaluate(() => scrollY);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let i = 1; i <= 10; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y - i * 12 }],
    });
  await mobile.waitForTimeout(150);
  assert(
    (await mobile
      .locator('[data-portrait="0"]')
      .evaluate((e) =>
        Number(e.style.transform.match(/translateY\(([-.\d]+)/)[1]),
      )) < -100,
  );
  assert.equal(await mobile.evaluate(() => scrollY), scroll);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await mobile.waitForTimeout(1200);
  assert.equal(
    await mobile
      .locator('[data-portrait="0"]')
      .evaluate((e) => e.style.transform),
    "translateX(0px) translateY(0px) rotate(-5deg) scale(1)",
  );
  console.log(
    "PASS Real homepage has Spring physics and upward native touch pull without scrolling",
  );
  await p.goto(base);
  await p.waitForTimeout(500);
  const dir = ".context/homepage-qa/home-chat-flow";
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const shot = () =>
    p.screenshot({ path: dir + "/" + String(n++).padStart(3, "0") + ".png" });
  await shot();
  const s = p.getByRole("group", { name: "Choose a speaker" });
  const sb = await s.boundingBox(),
    sx = sb.x + sb.width / 2,
    sy = sb.y + 130;
  await p.mouse.move(sx, sy);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await p.mouse.move(sx, sy - i * 13);
    await shot();
  }
  await p.mouse.up();
  for (let i = 0; i < 12; i++) {
    await shot();
    await p.waitForTimeout(35);
  }
  await p.unroute("**/api/chat");
  await p.route("**/api/chat", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body:
        "data: " +
        JSON.stringify({
          type: "text_delta",
          text: "UX walkthrough: this sample reply demonstrates the conversation layout. No search was run.",
        }) +
        "\n\n",
    }),
  );
  await p.locator("#clip-prompt").fill("Find a short clip about AGI.");
  await shot();
  await p.locator("#clip-prompt").press("Enter");
  await p.waitForURL(base + "/chat");
  await p.getByRole("log").waitFor();
  await p.waitForTimeout(500);
  await shot();
  await shot();
  await p.getByRole("button", { name: "New chat", exact: true }).click();
  await shot();
  assert.deepEqual(errors, []);
  await b.close();
  console.log("PASS Home → /chat → New chat walkthrough recorded");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
