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
  await p.route("**/api/speakers", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        speakers: [
          { name: "Ada Lovelace", slug: "ada-lovelace", videoCount: 12 },
        ],
      }),
    }),
  );
  await p.goto(base + "/preview/chat");
  await p.getByRole("log").waitFor();
  const content = await p.locator("main").innerText();
  assert(!content.includes("Searching Sam Altman"));
  assert(!content.includes("Clip conversation"));
  assert.equal(await p.locator("main img").count(), 0);
  assert.equal(
    await p.locator("[data-speaker-initial]").first().innerText(),
    "S",
  );
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
  await p.getByRole("heading", { name: "Search for a quote" }).waitFor();
  assert.equal(await p.getByRole("log").count(), 0);
  assert.equal(
    await p
      .getByRole("button", { name: "AI could change everything", exact: true })
      .count(),
    1,
  );
  await p
    .getByRole("button", {
      name: "Choose speaker, current: Sam Altman",
      exact: true,
    })
    .click();
  await p.getByRole("button", { name: "Elon Musk (0)", exact: true }).click();
  assert.equal(
    await p
      .getByRole("button", {
        name: "Choose speaker, current: Elon Musk",
        exact: true,
      })
      .count(),
    1,
  );
  await p
    .getByRole("button", {
      name: "Choose speaker, current: Elon Musk",
      exact: true,
    })
    .click();
  await p
    .getByRole("textbox", { name: "Search speakers", exact: true })
    .fill("Ada");
  await p
    .getByRole("button", { name: "Ada Lovelace (12)", exact: true })
    .click();
  assert.deepEqual(
    await p.locator("[data-speaker-initial]").allTextContents(),
    ["A", "A"],
  );
  assert.equal(await p.locator("main img").count(), 0);
  await p.getByRole("button", { name: "New chat", exact: true }).click();
  await p
    .getByRole("button", {
      name: "Choose speaker, current: Ada Lovelace",
      exact: true,
    })
    .waitFor();
  console.log(
    "PASS Always-visible searchable speaker selector and initials for speakers without photos",
  );
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
  // A tapped citation must visibly reveal the player, including before the
  // transcript arrives. External media is stubbed for deterministic layout QA.
  await mobile.route("**/api/transcript/**", (r) =>
    r.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await mobile.route("https://www.youtube.com/**", (r) => r.abort());
  await mobile.goto(base + "/preview/chat");
  const citation = mobile.locator("a[data-video-id]").first();
  await citation.tap();
  await mobile.waitForFunction(() => {
    const frame = document.querySelector("iframe")?.getBoundingClientRect();
    return frame && frame.top >= 0 && frame.bottom <= innerHeight;
  });
  assert((await mobile.locator("iframe").getAttribute("src")).includes("start=3965"));
  await mobile.getByRole("button", { name: "Back to chat" }).tap();
  assert.equal(await mobile.locator("iframe").count(), 0);
  assert(await citation.evaluate((e) => {
    const box = e.getBoundingClientRect();
    return document.activeElement === e && box.top >= 0 && box.bottom <= innerHeight;
  }));
  console.log("PASS Mobile citation reveals timestamped preview; Back to chat restores quote and focus");
  // Keep a real response stream open so citations can be selected while tokens
  // arrive. Repeated citations verify both message and link-occurrence identity.
  await mobile.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (input !== "/api/chat") return originalFetch(input, init);
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          window.emitChatToken = (text, done = false) => {
            controller.enqueue(new TextEncoder().encode(
              "data: " + JSON.stringify({ type: "text_delta", text }) + "\n\n",
            ));
            if (done) controller.close();
          };
        },
      }), { headers: { "Content-Type": "text/event-stream" } }));
    };
    const scrollIntoView = Element.prototype.scrollIntoView;
    window.messageScrollCalls = 0;
    Element.prototype.scrollIntoView = function (...args) {
      if (this.parentElement?.getAttribute("role") === "log")
        window.messageScrollCalls++;
      return scrollIntoView.apply(this, args);
    };
  });
  await mobile.goto(base + "/chat");
  await mobile.locator("#clip-prompt").fill("First search");
  await mobile.locator("#clip-prompt").press("Enter");
  await mobile.waitForFunction(() => typeof window.emitChatToken === "function");
  const repeated = "[Repeated quote](youtube:Q3E5fagbcsA:20)";
  await mobile.evaluate((text) => window.emitChatToken(text, true), repeated);
  await mobile.locator("#clip-prompt:not([disabled])").waitFor();
  await mobile.evaluate(() => { window.emitChatToken = null; });
  await mobile.locator("#clip-prompt").fill("Find two more moments");
  await mobile.locator("#clip-prompt").press("Enter");
  await mobile.waitForFunction(() => typeof window.emitChatToken === "function");
  await mobile.evaluate((text) => window.emitChatToken(text),
    repeated + "\n\n" + "More context.\n".repeat(20) + repeated);
  const repeatedCitation = mobile.locator(
    '[data-chat-message-index="3"] a[data-video-id]',
  ).nth(1);
  await repeatedCitation.tap();
  await mobile.waitForFunction(() => {
    const frame = document.querySelector("iframe")?.getBoundingClientRect();
    return frame && frame.top >= 0 && frame.bottom <= innerHeight;
  });
  await mobile.evaluate(() => {
    window.messageScrollCalls = 0;
    window.emitChatToken(" A streaming update.");
  });
  await mobile.getByText("A streaming update.", { exact: false }).waitFor();
  await mobile.waitForTimeout(150);
  assert.equal(await mobile.evaluate(() => window.messageScrollCalls), 0);
  await mobile.getByRole("button", { name: "Back to chat" }).tap();
  assert(await repeatedCitation.evaluate((e) => document.activeElement === e));
  await mobile.setViewportSize({ width: 1440, height: 1000 });
  await mobile.evaluate(() => { window.messageScrollCalls = 0; });
  await repeatedCitation.click();
  await mobile.waitForTimeout(150);
  assert.equal(await mobile.evaluate(() => window.messageScrollCalls), 0);
  await mobile.evaluate(() => window.emitChatToken(" Desktop update.", true));
  await mobile.waitForFunction(() => window.messageScrollCalls > 0);
  console.log("PASS Streaming preserves mobile preview; return restores exact repeated citation after HTML updates; desktop autoscroll unchanged");
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
