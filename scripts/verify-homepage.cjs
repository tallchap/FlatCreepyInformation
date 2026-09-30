// Run against a local server: PLAYWRIGHT_MODULE=/path/to/playwright node scripts/verify-homepage.cjs
// Chat responses are deterministic fixtures; no paid searches are made by this verifier.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const base = process.env.PREVIEW_URL || "http://127.0.0.1:4784";
const out = process.env.QA_OUTPUT || ".context/homepage-qa";
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const requests = [];
  const checks = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let fail = false;
  await page.route("**/api/chat", async (route) => {
    requests.push(route.request().postDataJSON());
    await new Promise((r) => setTimeout(r, 100));
    if (fail)
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Test service unavailable. Please try again.",
        }),
      });
    return route.fulfill({
      contentType: "text/event-stream",
      body:
        "data: " +
        JSON.stringify({
          type: "text_delta",
          text: "Here is a clip about AI safety.",
        }) +
        "\n\ndata: " +
        JSON.stringify({ type: "debug_file_search", results: ["fixture"] }) +
        "\n\n",
    });
  });
  await page.route("**/api/speakers", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"speakers":[]}' }),
  );
  async function home(p = page) {
    await p.goto(base);
    await p.getByRole("heading", { name: "Find a Sam Altman clip!" }).waitFor();
    await p.evaluate(() => document.fonts.ready);
    await p.waitForFunction(() =>
      [...document.querySelectorAll('img[src^="/speakers/"]')].every(
        (i) => i.complete && i.naturalWidth,
      ),
    );
  }
  const heading = () => page.locator("h1").innerText();
  await home();
  const text = await page.locator("main").innerText();
  for (const forbidden of [
    "You have a moment",
    "Search the conversations",
    "Drag to find",
    "conversations",
    "New chat",
    "of 7",
  ])
    assert(!text.includes(forbidden), forbidden);
  assert.equal(
    await page.getByRole("button", { name: "Previous speaker" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Next speaker" }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("group", { name: "Choose a speaker" })
      .locator("[data-dot]")
      .count(),
    0,
  );
  checks.push(
    "PASS Homepage removes requested prose, counter, arrows, dots, and conversation header",
  );
  await page.getByRole("group", { name: "Choose a speaker" }).focus();
  for (const name of [
    "Elon Musk",
    "Dario Amodei",
    "Geoffrey Hinton",
    "Eliezer Yudkowsky",
    "Demis Hassabis",
    "Yoshua Bengio",
    "Max Tegmark",
    "any speaker",
    "Sam Altman",
  ]) {
    await page.keyboard.press("ArrowRight");
    assert((await heading()).includes(name));
  }
  checks.push(
    "PASS All eight speakers in the requested order plus Any speaker remain selectable; keyboard wraparound works",
  );
  await page.keyboard.press("Home");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  assert.equal(await heading(), "Find an Eliezer Yudkowsky clip!");
  await page.keyboard.press("Home");
  checks.push("PASS Eliezer heading uses an");
  await page.waitForTimeout(550);
  const box = await page
    .getByRole("group", { name: "Choose a speaker" })
    .boundingBox();
  const x = box.x + box.width / 2,
    y = box.y + 65;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 80, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(550);
  assert((await heading()).includes("Elon Musk"));
  checks.push(
    "PASS Desktop drag still changes speaker without visible controls",
  );
  const stage = page.getByRole("group", { name: "Choose a speaker" });
  const activeCard = page.locator('[data-portrait="1"]');
  assert.equal(await activeCard.evaluate((e) => e.offsetWidth), 180);
  const resting = await activeCard.evaluate((e) => e.style.transform);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 20, y, { steps: 8 });
  const pulled = await activeCard.evaluate((e) => e.style.transform);
  assert.notEqual(pulled, resting);
  await page.waitForTimeout(150); // A small held pull should return, not count as a flick.
  await page.mouse.up();
  await page.waitForTimeout(800);
  assert((await heading()).includes("Elon Musk"));
  assert.equal(await activeCard.evaluate((e) => e.style.transform), resting);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 85, y, { steps: 6 });
  await stage.evaluate((e) =>
    e.dispatchEvent(
      new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
    ),
  );
  await page.mouse.up();
  await page.waitForTimeout(800);
  assert((await heading()).includes("Elon Musk"));
  assert.equal(await activeCard.evaluate((e) => e.style.transform), resting);
  // Catch a card mid-spring, reverse the gesture, and verify a clean final settle.
  await stage.press("ArrowRight");
  await page.waitForTimeout(90);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 90, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  assert((await heading()).includes("Elon Musk"));
  assert.equal(await activeCard.evaluate((e) => e.style.transform), resting);
  checks.push(
    "PASS Larger cards track the pointer, settle after small pulls/cancellation, and support reversing mid-spring",
  );
  await page.locator("#clip-prompt").fill("Find a quote about safety");
  await page.locator("#clip-prompt").press("Enter");
  await page.waitForURL(base + "/chat");
  await page
    .getByText("Here is a clip about AI safety.", { exact: true })
    .waitFor();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].speaker, "elon-musk");
  assert.equal(requests[0].speakerName, "Elon Musk");
  assert.equal(requests[0].message, "Find a quote about safety");
  assert.equal(requests[0].messages.length, 1);
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("snippysaurus:new-chat")),
    null,
  );
  checks.push(
    "PASS Homepage submits once on /chat with selected speaker and first message; handoff consumed",
  );
  await page.screenshot({ path: out + "/chat-desktop.png", fullPage: true });
  await page.locator("#clip-prompt").fill("Give me another one");
  await page.locator("#clip-prompt").press("Enter");
  await page.waitForFunction(
    () => !document.querySelector("#clip-prompt").disabled,
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1].messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  checks.push(
    "PASS Follow-up includes previous assistant reply and full conversation history",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Search results", exact: true })
      .count(),
    1,
  );
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  assert((await heading()).includes("Elon Musk"));
  assert.equal(
    await page
      .getByRole("button", { name: "Search results", exact: true })
      .count(),
    0,
  );
  checks.push(
    "PASS New chat clears conversation and debug data while keeping speaker",
  );
  await page.reload();
  await page.locator("h1").waitFor();
  await page.waitForTimeout(250);
  assert.equal(requests.length, 2);
  checks.push("PASS Reload does not resend consumed homepage prompt");
  await home();
  await page
    .getByRole("button", { name: /AI could change everything/ })
    .click();
  assert(
    (await page.locator("#clip-prompt").inputValue()).includes("Sam Altman"),
  );
  await page.locator("#clip-prompt").press("Shift+Enter");
  assert((await page.locator("#clip-prompt").inputValue()).includes("\n"));
  assert.equal(requests.length, 2);
  await page.getByRole("button", { name: "Find a clip", exact: true }).click();
  await page.waitForURL(base + "/chat");
  await page
    .getByText("Here is a clip about AI safety.", { exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector("#clip-prompt").disabled,
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[2].speaker, "sam-altman");
  assert.equal(requests[2].messages.length, 1);
  checks.push(
    "PASS Second homepage submission starts a fresh chat; suggestions and multiline entry work",
  );
  fail = true;
  await page.locator("#clip-prompt").fill("Try an error");
  await page.locator("#clip-prompt").press("Enter");
  await page
    .getByText("Test service unavailable. Please try again.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#clip-prompt").isEnabled(), true);
  checks.push("PASS Request failure is visible and composer recovers");
  fail = false;
  await page
    .getByRole("button", { name: "Change speaker", exact: true })
    .click();
  await page.getByRole("button", { name: "Sam Altman", exact: true }).click();
  await page
    .getByRole("button", { name: "Yoshua Bengio (0)", exact: true })
    .click();
  assert((await heading()).includes("Yoshua Bengio"));
  checks.push(
    "PASS Full speaker picker keeps featured speakers available when listing API is empty",
  );
  await page.goto(base + "/search");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Search", exact: true })
    .waitFor();
  assert.equal(
    await page.locator('a[href="/search"][aria-current="page"]').count(),
    1,
  );
  checks.push("PASS Keyword search remains available at /search");
  await home();
  const bodyText = await page.locator("body").innerText();
  for (const removed of [
    "Real quotes. Original videos. Right to the moment.",
    "vdev",
    "Photo credits",
  ])
    assert(!bodyText.includes(removed));
  assert.equal(await page.locator("footer").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Any speaker", exact: true })
      .count(),
    0,
  );
  await page.getByRole("group", { name: "Choose a speaker" }).press("End");
  assert.equal(await heading(), "Find a clip from any speaker!");
  assert.equal(
    await page
      .locator('[data-portrait][aria-pressed="true"]')
      .getAttribute("aria-label"),
    "Select Any speaker",
  );
  await page
    .getByRole("button", { name: /AI could change everything/ })
    .click();
  await page.getByRole("button", { name: "Find a clip", exact: true }).click();
  await page.waitForURL(base + "/chat");
  await page
    .getByText("Here is a clip about AI safety.", { exact: true })
    .waitFor();
  assert.equal(requests.at(-1).speaker, "all");
  assert.equal(requests.at(-1).speakerName, "Any speaker");
  await page
    .getByText("All speakers’ conversations", { exact: true })
    .waitFor();
  checks.push(
    "PASS Any speaker survives homepage handoff and submits the all-speakers search; footer copy removed",
  );
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await home();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const composerBox = await page.locator("form").boundingBox();
    const suggestionBox = await page
      .getByRole("button", { name: /AI could change everything/ })
      .boundingBox();
    assert(suggestionBox.y >= composerBox.y + composerBox.height);
    await page.screenshot({ path: out + `/home-${width}.png`, fullPage: true });
    if (width === 390 || width === 1440) {
      await page.getByRole("group", { name: "Choose a speaker" }).press("End");
      await page.waitForTimeout(550);
      await page.screenshot({
        path: out + `/any-speaker-${width}.png`,
        fullPage: true,
      });
    }
    await page.goto(base + "/chat");
    await page.locator("h1").waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  checks.push(
    "PASS Homepage and /chat responsive at 320, 390, 768, and 1440px",
  );
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await home(mobile);
  const cdp = await mobile.context().newCDPSession(mobile);
  const a = await mobile
    .getByRole("group", { name: "Choose a speaker" })
    .boundingBox();
  const tx = a.x + a.width / 2,
    ty = a.y + 60;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: tx, y: ty }],
  });
  for (let i = 1; i <= 8; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: tx - i * 11, y: ty }],
    });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await mobile.waitForTimeout(550);
  assert((await mobile.locator("h1").innerText()).includes("Elon Musk"));
  checks.push("PASS Native Chromium touch swipe works in the React homepage");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await home();
  await page.getByRole("group", { name: "Choose a speaker" }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page
      .locator('[data-portrait="1"]')
      .evaluate((e) => getComputedStyle(e).transitionDuration),
    "0s",
  );
  checks.push("PASS Reduced-motion preference honored");
  assert.deepEqual(errors, []);
  checks.push("PASS No page JavaScript errors");
  fs.writeFileSync(
    out + "/verification.txt",
    new Date().toISOString() +
      "\nRequested: cleaned homepage, swipe picker, first-message handoff to /chat.\nConducted: browser interactions with fixture chat responses.\n" +
      checks.join("\n") +
      "\nLive model search: not used in this deterministic UI check.\nFeedback learning: not part of this feature.\n",
  );
  console.log(checks.join("\n"));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
