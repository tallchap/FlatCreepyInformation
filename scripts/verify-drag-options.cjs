const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
  let errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(
    (process.env.PREVIEW_URL || "http://127.0.0.1:4784") + "/preview/drag",
  );
  await p.waitForTimeout(600);
  for (const [id, title] of [
    ["glide", "A · Free glide"],
    ["spring", "B · Spring deck"],
    ["loose", "C · Loose cards"],
  ]) {
    await p
      .getByRole("button", { name: new RegExp(title.replace(" · ", ".*")) })
      .click();
    const stage = p.getByRole("group", { name: "Choose a speaker" });
    await stage.press("Home");
    await p.waitForTimeout(800);
    const box = await stage.boundingBox(),
      x = box.x + box.width / 2,
      y = box.y + 130;
    await p.mouse.move(x, y);
    await p.mouse.down();
    await p.mouse.move(x - 420, y + 35, { steps: 25 });
    await p.waitForTimeout(150);
    const transform = await p
      .locator('[data-portrait="0"]')
      .evaluate((e) => e.style.transform);
    assert(
      Number(transform.match(/translateX\(([-.\d]+)/)[1]) < -400,
      transform,
    );
    await p.mouse.up();
    await p.waitForTimeout(1200);
    assert(
      (await p.locator("h1").last().innerText()).includes("Geoffrey Hinton"),
    );
    await stage.evaluate((e) => e.blur());
    await p.screenshot({
      path: ".context/homepage-qa/drag-" + id + ".png",
      fullPage: true,
    });
    console.log("PASS", id, "multi-card travel and settle");
  }

  await p.getByRole("button", { name: /B.*Spring deck/ }).click();
  const stage = p.getByRole("group", { name: "Choose a speaker" });
  await stage.press("Home");
  await stage.press("ArrowRight");
  await p.waitForTimeout(1000);
  const box = await stage.boundingBox(),
    x = box.x + box.width / 2,
    y = box.y + 125;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x, y - 125, { steps: 15 });
  await p.waitForTimeout(200);
  const card = p.locator('[data-portrait="1"]');
  const lifted = await card.evaluate((e) =>
    Number(e.style.transform.match(/translateY\(([-.\d]+)/)[1]),
  );
  assert(
    lifted < -100,
    "Straight-up drag should visibly lift the card: " + lifted,
  );
  await p.screenshot({
    path: ".context/homepage-qa/spring-lift-desktop.png",
    fullPage: true,
  });
  await p.mouse.up();
  await p.waitForTimeout(1200);
  assert((await p.locator("h1").last().innerText()).includes("Elon Musk"));
  assert.equal(
    await card.evaluate((e) => e.style.transform),
    "translateX(0px) translateY(0px) rotate(-5deg) scale(1)",
  );
  console.log(
    "PASS Spring accepts direct upward dragging and returns smoothly without changing speaker",
  );
  for (const name of [
    "1 · Intense focus",
    "2 · Hard light",
    "Previous option",
    "Original",
  ]) {
    await p.getByRole("button", { name, exact: true }).click();
    await p.waitForFunction(() =>
      [...document.querySelectorAll('img[src^="/speakers/"]')].every(
        (i) => i.complete && i.naturalWidth,
      ),
    );
  }
  await p
    .getByRole("button", { name: "1 · Intense focus", exact: true })
    .click();
  await p.waitForTimeout(400);
  await p.screenshot({
    path: ".context/homepage-qa/spring-options.png",
    fullPage: true,
  });
  await stage.press("Home");
  await p
    .getByRole("button", { name: "1 · Intense focus", exact: true })
    .click();
  assert((await p.locator("h1").last().innerText()).includes("Elon Musk"));
  const mobile = await b.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await mobile.goto(
    (process.env.PREVIEW_URL || "http://127.0.0.1:4784") + "/preview/drag",
  );
  await mobile.waitForTimeout(400);
  const ms = mobile.getByRole("group", { name: "Choose a speaker" });
  await ms.scrollIntoViewIfNeeded();
  const mb = await ms.boundingBox(),
    mx = mb.x + mb.width / 2,
    my = mb.y + 125;
  const cdp = await mobile.context().newCDPSession(mobile);
  const beforeScroll = await mobile.evaluate(() => scrollY);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: mx, y: my }],
  });
  for (let i = 1; i <= 10; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: mx, y: my - i * 12 }],
    });
  await mobile.waitForTimeout(200);
  assert(
    (await mobile
      .locator('[data-portrait="1"]')
      .evaluate((e) =>
        Number(e.style.transform.match(/translateY\(([-.\d]+)/)[1]),
      )) < -100,
  );
  assert.equal(await mobile.evaluate(() => scrollY), beforeScroll);
  await mobile.screenshot({
    path: ".context/homepage-qa/spring-lift-mobile.png",
    fullPage: true,
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await mobile.waitForTimeout(1200);
  assert((await mobile.locator("h1").last().innerText()).includes("Elon Musk"));
  console.log(
    "PASS Native touch upward drag moves the portrait, preserves page position, and settles on the same speaker",
  );
  for (const width of [320, 390, 768, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await p.emulateMedia({ reducedMotion: "reduce" });
  await stage.press("ArrowRight");
  await p.waitForTimeout(30);
  assert.equal(
    await p.locator('[data-portrait="2"]').evaluate((e) => e.style.transform),
    "translateX(0px) translateY(0px) rotate(-5deg) scale(1)",
  );
  console.log("PASS Photo choices, responsive widths, and reduced motion");

  await p.setViewportSize({ width: 390, height: 844 });
  await p.screenshot({
    path: ".context/homepage-qa/drag-options-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  assert.deepEqual(errors, []);
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
