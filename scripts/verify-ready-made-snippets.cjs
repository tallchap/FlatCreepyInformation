// Live saved-snippet verification. Mobile/tablet configurations are emulated.
// Edge-case fixtures are injected only in Chromium and are explicitly reported.
const { chromium, firefox, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.PREVIEW_URL || 'http://localhost:4786';
const out = path.resolve(process.env.QA_OUT || '.context/snippet-transcript/qa');
fs.mkdirSync(out, { recursive: true });
const matrix = [
  ['chromium-desktop', chromium, { viewport: { width: 1440, height: 1000 } }],
  ['firefox-desktop', firefox, { viewport: { width: 1440, height: 1000 } }],
  ['webkit-desktop', webkit, { viewport: { width: 1440, height: 1000 } }],
  ['android', chromium, devices['Pixel 7']],
  ['iphone', webkit, devices['iPhone 13']],
  ['ipad', webkit, devices['iPad (gen 7)']],
];
const results = [];
const clean = text => text.replace(/\n{2,}/g, '\n').trim();
async function fit(p) {
  await p.waitForFunction(() => {
    const a = document.querySelector('[data-testid=snippet-player]')?.getBoundingClientRect();
    const b = document.querySelector('[data-testid=snippet-transcript]')?.getBoundingClientRect();
    if (!a || !b) return false;
    return innerWidth >= 1024 ? Math.abs(a.top-b.top)<2 && Math.abs(a.bottom-b.bottom)<2 && b.left-a.right<=13 : b.top>=a.bottom;
  });
  assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
  assert(await p.getByRole('region', { name: 'Snippet transcript text', exact: true }).evaluate(e => e.clientHeight > 80), 'Transcript must have a usable scroll area');
}
async function selected(p, snippet) {
  const section = p.getByTestId('ready-made-snippets');
  assert.equal(await section.locator('video').count(), 1);
  assert.equal(await section.locator('h3 button[aria-expanded=true]').count(), 1);
  assert.equal(await section.locator('video').getAttribute('src'), snippet.gcsUrl);
  assert.equal(await section.getByRole('link', { name: 'Download Snippet' }).getAttribute('href'), snippet.gcsUrl);
  assert.equal(await p.getByRole('region', { name: 'Snippet transcript text', exact: true }).locator('p').textContent(), clean(snippet.transcript));
  await fit(p);
}
(async () => {
  for (const [name, engine, options] of matrix) {
    if (process.env.QA_DEVICE && !process.env.QA_DEVICE.split(',').includes(name)) continue;
    const b = await engine.launch(); const p = await b.newPage(options); p.setDefaultTimeout(20000);
    const checks = [], errors = []; p.on('pageerror', e => errors.push(e.message));
    const shot = suffix => p.screenshot({path:path.join(out, `${name}-${suffix}.png`), animations:'disabled'});
    try {
      const data = {};
      for (const id of ['CRraHg4Ks_g', 'UWh1MIMQd1Y']) {
        const response = await p.request.get(`${base}/api/snippets/auto?videoId=${id}`);
        assert(response.ok()); data[id] = await response.json();
      }
      assert.equal(data.CRraHg4Ks_g.length, 1); assert.equal(data.UWh1MIMQd1Y.length, 6);
      await p.goto(base + '/edit?v=CRraHg4Ks_g', {waitUntil:'domcontentloaded'});
      const section = p.getByTestId('ready-made-snippets'); await section.waitFor({timeout:60000});
      await section.scrollIntoViewIfNeeded();
      assert.equal(await section.getByTestId('snippet-row').count(), 1);
      assert.equal(await section.getByTestId('snippet-chooser').count(), 0);
      await selected(p, data.CRraHg4Ks_g[0]); await shot('single');
      checks.push('Single snippet opens directly with its exact stored transcript and download link');
      const first = section.locator('h3 button').first();
      await first.focus(); await first.press('Enter'); assert.equal(await section.locator('video').count(), 0);
      assert.equal(await first.getAttribute('aria-expanded'), 'false');
      await first.press('Space'); await selected(p, data.CRraHg4Ks_g[0]);
      checks.push('Keyboard collapse and reopen work with correct accessible expanded state');
      await p.goto(base + '/edit?v=UWh1MIMQd1Y', {waitUntil:'domcontentloaded'});
      await section.waitFor({timeout:60000}); await section.scrollIntoViewIfNeeded();
      const rows = section.getByTestId('snippet-row'); assert.equal(await rows.count(), 6);
      await selected(p, data.UWh1MIMQd1Y[0]);
      const video = section.locator('video');
      await video.scrollIntoViewIfNeeded();
      await video.evaluate(v => { v.muted=true; return v.play(); });
      await p.waitForFunction(() => document.querySelector('[data-testid=ready-made-snippets] video')?.currentTime > 1);
      await video.evaluate(v => v.pause()); await shot('multiple');
      const oldVideo = await video.elementHandle();
      await video.evaluate(v => v.play());
      checks.push('Existing saved media plays with native inline controls');
      for (let i=1;i<6;i++) {
        await rows.nth(i).locator('h3 button').click(); await selected(p, data.UWh1MIMQd1Y[i]);
      }
      assert(await oldVideo.evaluate(v => !v.isConnected));
      await p.waitForFunction(v => v.paused, oldVideo);
      await shot('last-snippet');
      checks.push('All six rows switch player, transcript and download together with only one player mounted');
      const scroll = p.getByRole('region', {name:'Snippet transcript text', exact:true});
      assert(await scroll.evaluate(e => e.scrollHeight > e.clientHeight), 'Long transcript needs independent scrolling');
      await scroll.evaluate(e => e.scrollTop=e.scrollHeight);
      assert(await scroll.evaluate(e => e.scrollTop > 0));
      await shot('scrolled-transcript');
      checks.push('Long transcript scrolls within its pane without stretching the video row');
      await rows.nth(5).locator('h3 button').click();
      assert.equal(await section.locator('video').count(),0);
      assert.equal(await section.getByTestId('snippet-transcript').count(),0);
      await shot('collapsed');
      await rows.nth(0).locator('h3 button').click(); await selected(p,data.UWh1MIMQd1Y[0]);
      checks.push('Multiple snippets can all collapse and reopen without stale media or transcript');
      if (name.endsWith('desktop')) {
        for (const width of [1024,768,320,1440]) {
          await p.setViewportSize({width,height:1000}); await fit(p);
          if(width===320) {await section.scrollIntoViewIfNeeded(); await shot('320px');}
        }
      }
      checks.push('Responsive pane alignment and page width fit the device, including desktop resize breakpoints');
      if (name==='chromium-desktop') {
        let fixture=[{...data.CRraHg4Ks_g[0],transcript:null,description:null,speaker:null,title:'Snippet without transcript'}];
        await p.route('**/api/snippets/auto?*', route=>route.fulfill({json:fixture}));
        await p.goto(base+'/edit?v=CRraHg4Ks_g',{waitUntil:'domcontentloaded'});
        await section.waitFor({timeout:60000});
        assert.equal(await p.getByRole('region',{name:'Snippet transcript text',exact:true}).innerText(),'No transcript available for this snippet');
        assert(await section.getByRole('link',{name:'Download Snippet'}).isVisible());
        await fit(p); await section.scrollIntoViewIfNeeded(); await shot('missing-transcript');
        fixture=[];
        const response = p.waitForResponse(r=>r.url().includes('/api/snippets/auto?'));
        await p.reload({waitUntil:'domcontentloaded'}); await response;
        await p.getByRole('checkbox',{name:'Follow playback'}).waitFor({timeout:60000});
        assert.equal(await section.count(),0);
        checks.push('Injected missing-transcript and empty-list fixtures show fallback and omit empty section');
      }
      assert.deepEqual(errors,[]); results.push({name,pass:true,checks,errors});console.log(`PASS ${name} (${checks.length} checks)`);
    } catch(e) { results.push({name,pass:false,checks,error:e.stack,errors});console.error(`FAIL ${name}: ${e.stack}`);await shot('failure').catch(()=>{}); }
    finally { await b.close();fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({time:new Date().toISOString(),base,devices:'Desktop browsers and mobile/tablet emulation; no physical devices',results},null,2)); }
  }
  process.exitCode=results.some(r=>!r.pass)?1:0;
})().catch(e=>{console.error(e);process.exitCode=1});
