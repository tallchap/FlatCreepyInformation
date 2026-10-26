#!/usr/bin/env node
// YouTube-only clipping verifier: runs the spec walkthrough end to end against
// production and prints a checklist. Any red item → exit 1.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/verify-yt-only.mjs
//     [--site https://www.snippysaurus.com] [--render https://snippysaurus-download.onrender.com]
//     [--video anAmTGcewX8] [--seg 252-297,1110.5-1160.5,2465-2500]
//     [--reference <local copy of the source mp4>]   (else pulled via RapidAPI)
//     [--wait-ttl]                                   (also wait 31 min and check /tmp is empty)
//
// Needs .env.local (GOOGLE_APPLICATION_CREDENTIALS_JSON, BUNNY_STREAM_API_KEY,
// RAPIDAPI_KEY), ffmpeg/ffprobe, curl and Playwright with Chrome.
// Writes the report, clip and screenshots to .context/verify-yt-only/<stamp>/.

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { BigQuery } from "@google-cloud/bigquery";
import { checkJoins } from "./yt-only/frame-match.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const SITE = arg("site", "https://www.snippysaurus.com").replace(/\/$/, "");
const RENDER = arg("render", "https://snippysaurus-download.onrender.com").replace(/\/$/, "");
const VIDEO = arg("video", "anAmTGcewX8");
const SEG = arg("seg", "252-297,1110.5-1160.5,2465-2500");
const QUALITY = "1080p"; // the editor always exports at 1080p
const SEGMENTS = SEG.split(",").map((p) => { const [a, b] = p.split("-").map(Number); return { in: a, out: b }; });
const TOTAL = SEGMENTS.reduce((a, s) => a + s.out - s.in, 0);
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.join(ROOT, ".context", "verify-yt-only", STAMP);
fs.mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); let v = l.slice(i + 1); if (v.startsWith('"')) v = v.slice(1, v.lastIndexOf('"')); return [l.slice(0, i), v]; }));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const checks = [];
const t0 = Date.now();
function check(name, status, detail = "") {
  checks.push({ name, status, detail });
  const mark = status === "pass" ? "\x1b[32m✓\x1b[0m" : status === "warn" ? "\x1b[33m!\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (e, so, se) => (e ? rej(Object.assign(e, { stderr: se })) : res({ stdout: so, stderr: se }))));
const fmtSec = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

function bq() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  let c;
  try { c = JSON.parse(raw); } catch { c = JSON.parse(raw.replace(/"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/, (_m, k) => `"private_key":"${k.replace(/\n/g, "\\n")}","client_email"`)); }
  return new BigQuery({ credentials: c, projectId: c.project_id });
}
async function bunny(p) {
  const r = await fetch(`https://video.bunnycdn.com/library/627230${p}`, { headers: { AccessKey: (process.env.BUNNY_STREAM_API_KEY || "").trim() } });
  if (!r.ok) throw new Error(`Bunny ${r.status}`);
  return r.json();
}

async function main() {
  console.log(`yt-only verifier · ${SITE} · render ${RENDER} · video ${VIDEO} · ${SEGMENTS.length} segments, total ${fmtSec(TOTAL)} · ${QUALITY}\n`);
  const report = { site: SITE, render: RENDER, video: VIDEO, segments: SEGMENTS, quality: QUALITY, startedAt: new Date().toISOString() };

  // ── 1. The video row: yt-only, no Bunny asset ──
  const bunnyBefore = (await bunny("/videos?page=1&itemsPerPage=1")).totalItems;
  report.bunnyBefore = bunnyBefore;
  const b = bq();
  const [[row]] = await b.query({
    query: `SELECT ANY_VALUE(video_title) title, ANY_VALUE(video_length) video_length, ANY_VALUE(video_source) video_source, COUNT(*) n
            FROM \`youtubetranscripts-429803.reptranscripts.youtube_videos\` WHERE video_id = @id`, params: { id: VIDEO } });
  check("video row exists, video_source='youtube'", row?.n === 1 && row.video_source === "youtube" ? "pass" : "fail",
    row?.n ? `${row.n} row · video_source=${row.video_source} · ${row.title}` : "no row");
  const hits = ((await bunny(`/videos?search=${VIDEO}&itemsPerPage=10`)).items || []).filter((v) => (v.title || "").includes(VIDEO));
  check("no Bunny asset for the video", hits.length === 0 ? "pass" : "fail", hits.length ? `${hits.length} Bunny items: ${hits.map((h) => h.guid).join(", ")}` : `library holds ${bunnyBefore} videos, none for ${VIDEO}`);

  // ── 2. Transcript + search windows ──
  const [[seg]] = await b.query({
    query: `SELECT COUNT(DISTINCT segment_index) n, MAX(start_sec) last_start FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcript_segments\` WHERE video_id = @id`, params: { id: VIDEO } });
  const [[win]] = await b.query({
    query: `SELECT COUNT(*) n FROM \`youtubetranscripts-429803.reptranscripts.segment_search_windows\` WHERE video_id = @id`, params: { id: VIDEO } });
  const lenSec = (row?.video_length || "").split(":").map(Number).reduce((a, x) => a * 60 + x, 0) || null;
  const coverage = lenSec ? seg.last_start / lenSec : null;
  // The spec guessed "> 2,000 segments"; Apify groups this talk's captions into ~1,100
  // lines, so the real bar is coverage: lines reach ≥ 80% of the video, ≥ 1 per 10 s.
  report.transcript = { segments: seg.n, lastStart: seg.last_start, lengthSec: lenSec, windows: win.n };
  check("transcript stored and covers the video", seg.n > 0 && coverage >= 0.8 && seg.n >= (lenSec || 0) / 10 ? "pass" : "fail",
    `${seg.n} segments, last at ${fmtSec(seg.last_start || 0)} of ${fmtSec(lenSec || 0)} (${Math.round((coverage || 0) * 100)}%)`);
  check("search windows present (one per caption line)", win.n === seg.n && win.n > 0 ? "pass" : "fail", `${win.n} windows / ${seg.n} lines`);

  // ── 3. Editor page + 4. export through the UI ──
  const editUrl = `${SITE}/edit?v=${VIDEO}&seg=${SEG}`;
  const pageRes = await fetch(editUrl);
  check("/edit?v=…&seg=… returns 200", pageRes.status === 200 ? "pass" : "fail", `HTTP ${pageRes.status}`);

  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  const lookups = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (/bunny-lookup|clip-gcs-check|\/api\/clip-gcs/.test(r.url())) lookups.push(r.url()); });
  await page.goto(editUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="segment-active"]', { timeout: 90_000 });
  await page.waitForTimeout(3000);
  const total = (await page.textContent('[data-testid="segment-total"]'))?.trim();
  // The panel shows only the active segment; the full list rides in a hidden element.
  const panel = JSON.parse((await page.getAttribute('[data-testid="segment-list"]', "data-segments")) || "[]");
  const shownRows = await page.$$('[data-testid="segment-active"]');
  const shownText = (await page.textContent('[data-testid="segment-active"] [data-testid="segment-text"]'))?.trim();
  const expectTotal = fmtSec(TOTAL);
  check(`segment panel shows one segment (the active one), total ${expectTotal}`,
    total === expectTotal && panel.length === SEGMENTS.length && shownRows.length === 1 ? "pass" : "fail",
    `total "${total}" · shown: ${shownText} · ${panel.length} segments in the clip`);
  const panelMatches = JSON.stringify(panel.map(({ in: a, out: o }) => ({ in: a, out: o }))) === JSON.stringify(SEGMENTS);
  check("panel segments equal the deep link", panelMatches ? "pass" : "fail", JSON.stringify(panel.map(({ in: a, out: o }) => [a, o])));
  const filmstrip = await page.getAttribute('[data-testid="filmstrip"]', "data-source").catch(() => null);
  const badge = !!(await page.$('[data-testid="yt-only-badge"]'));
  const iframeSrc = await page.getAttribute("#clip-player iframe", "src").catch(() => null);
  const pv = iframeSrc ? Object.fromEntries(new URL(iframeSrc).searchParams) : {};
  check("editor mounts the clean YouTube embed (no Bunny/GCS lookups)",
    badge && lookups.length === 0 && pv.controls === "0" && pv.rel === "0" && pv.fs === "0" && pv.disablekb === "1" && pv.iv_load_policy === "3" ? "pass" : "fail",
    `badge=${badge} lookups=${lookups.length} controls=${pv.controls} rel=${pv.rel} fs=${pv.fs} disablekb=${pv.disablekb} iv_load_policy=${pv.iv_load_policy} shield=${!!(await page.$('[data-testid="yt-shield"]'))}`);
  check("timeline filmstrip from YouTube storyboard", filmstrip === "storyboard" ? "pass" : filmstrip === "thumbnails" ? "warn" : "fail", `source=${filmstrip}`);
  const picker = await page.$$('[data-testid^="quality-"]');
  check("no quality picker (always 1080p)", picker.length === 0 ? "pass" : "fail", `${picker.length} quality buttons on the page`);
  await page.waitForSelector('[data-testid="export-estimate"]', { timeout: 20_000 }).catch(() => null);
  const preEstimate = (await page.textContent('[data-testid="export-estimate"]').catch(() => null))?.trim() || null;
  report.preEstimate = preEstimate;
  check("estimate shown before export", preEstimate ? "pass" : "fail", preEstimate || "no estimate next to Export");
  await page.screenshot({ path: path.join(OUT, "editor.png"), fullPage: true });

  // Export: click the button, capture the exact payload the UI sends.
  const reqPromise = page.waitForRequest((r) => r.url().endsWith("/api/clip") && r.method() === "POST", { timeout: 30_000 });
  const resPromise = page.waitForResponse((r) => r.url().endsWith("/api/clip") && r.request().method() === "POST", { timeout: 60_000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 15 * 60_000 });
  const exportAt = Date.now();
  await page.click('[data-testid="export-snippet"]');
  const req = await reqPromise;
  const payload = req.postDataJSON();
  report.payload = payload;
  const sentSegs = JSON.stringify(payload.segments);
  check("export requests 1080p", payload.quality === "1080p" ? "pass" : "fail", `quality=${payload.quality}`);
  check("API payload segments equal the panel, byte for byte", sentSegs === JSON.stringify(panel.map(({ in: a, out: o }) => ({ in: a, out: o }))) ? "pass" : "fail", sentSegs);
  const res = await resPromise;
  const started = await res.json().catch(() => ({}));
  if (!started.jobId) {
    check("export job started", "fail", `HTTP ${res.status()} ${JSON.stringify(started)}`);
    await browser.close();
    return finish(report);
  }
  const jobId = started.jobId;
  report.jobId = jobId;
  report.initialEtaSec = started.etaSec ?? null;
  check("export job started with an ETA", started.etaSec != null ? "pass" : "fail", `job ${jobId} · route ${started.route} · initial ETA ${started.etaSec ?? "?"} s`);

  // Poll the job ourselves for stages + source; the page keeps its own poll and downloads.
  const stages = [];
  const etaTrace = [];
  let panelEtaSeen = null;
  let status = null;
  while (Date.now() - exportAt < 15 * 60_000) {
    await sleep(3000);
    const r = await fetch(`${SITE}/api/clip-status?jobId=${jobId}`, { cache: "no-store" });
    if (!r.ok) continue;
    status = await r.json();
    const s = `${status.stage || "-"}`;
    etaTrace.push({ atSec: Number(((Date.now() - exportAt) / 1000).toFixed(1)), etaSec: status.etaSec, stage: s });
    if (!panelEtaSeen) panelEtaSeen = (await page.textContent('[data-testid="download-eta"]').catch(() => null))?.trim() || null;
    if (stages.at(-1) !== s) { stages.push(s); console.log(`    ${((Date.now() - exportAt) / 1000).toFixed(0).padStart(4)}s  ${s}  ${status.stageDetail || ""}  · ETA ${status.etaSec ?? "?"} s`); }
    if (status.status === "ready" || status.status === "failed") break;
  }
  const readySec = (Date.now() - exportAt) / 1000;
  report.status = status;
  report.stages = stages;
  report.requestToReadySec = readySec;
  check("export job completes, source recorded", status?.status === "ready" && status.source ? "pass" : "fail",
    `${status?.status} · source=${status?.source} · request→ready ${readySec.toFixed(1)} s${status?.attempts ? ` · attempts ${status.attempts.map((a) => `${a.source}:${a.ok ? "ok" : "failed"}`).join(", ")}` : ""}${status?.error ? ` · ${String(status.error).slice(0, 300)}` : ""}`);
  report.trimChecks = status?.trimChecks || null;
  if (status?.source === "rapidapi-trim") {
    const tc = status.trimChecks || [];
    check("witness check ran on every segment", tc.length === SEGMENTS.length && tc.every((c) => c && c.witness && c.d != null) ? "pass" : "warn",
      tc.map((c) => c ? `#${c.segment} ${c.path}${c.tries > 1 ? ` after ${c.tries} tries` : ""} d=${c.d}${c.correction ? ` → corrected +${c.correction}f` : ""} (err ${c.err})` : "?").join(" · ") + ` · copy-path retries ${status.copyPathRetries || 0}`);
    if (tc.some((c) => c?.unverifiedCopyPath)) check("no segment left on an unverified copy-path trim", "fail", "every retry came back from the copy path");
  }
  report.etaTrace = etaTrace;
  report.panelEta = panelEtaSeen;
  check("download panel shows \"ready in …\" while exporting", panelEtaSeen ? "pass" : "fail", panelEtaSeen || "not seen");
  if (status?.status === "ready" && started.etaSec != null) {
    const err = (started.etaSec - readySec) / readySec;
    const mid = etaTrace[Math.floor(etaTrace.length / 2)];
    const midErr = mid ? (mid.atSec + (mid.etaSec || 0) - readySec) : null;
    report.etaAccuracy = { initialEtaSec: started.etaSec, actualSec: readySec, initialErrPct: Math.round(err * 100), midwayPredictedTotal: mid ? mid.atSec + mid.etaSec : null };
    check("initial ETA within ±35% of the real time", Math.abs(err) <= 0.35 ? "pass" : "warn",
      `estimated ${started.etaSec} s, took ${readySec.toFixed(0)} s (${err >= 0 ? "+" : ""}${Math.round(err * 100)}%) · halfway it predicted ${mid ? (mid.atSec + mid.etaSec).toFixed(0) : "?"} s total (${midErr != null ? (midErr >= 0 ? "+" : "") + midErr.toFixed(0) : "?"} s)`);
  }
  if (status?.bytesPulled) {
    const fetchedSec = SEGMENTS.reduce((a, sg) => a + Math.ceil(sg.out) - Math.floor(sg.in) + 2, 0);
    const lenS = report.transcript?.lengthSec || 1;
    report.data = { bytesPulled: status.bytesPulled, fetchedSec, videoSec: lenS };
    check("pulls only the moments needed (< 25% of the video)", status.source === "rapidapi-trim" && fetchedSec / lenS < 0.25 ? "pass" : "fail",
      `${(status.bytesPulled / 1024 / 1024).toFixed(1)} MB for ${fetchedSec} s of ${lenS} s (${((fetchedSec / lenS) * 100).toFixed(1)}%) · quality used ${status.qualityUsed || "?"}`);
  }
  const perSeg = SEGMENTS.length > 1;
  const logged = (status?.stageLog || []).map((x) => x.stage);
  const seen = logged.length ? logged : stages;
  report.stageLog = status?.stageLog || null;
  check("per-segment progress stages reported", !perSeg || (seen.some((s) => /^fetching \d+\/\d+$/.test(s) || s === "downloading-video") && seen.some((s) => /^cutting \d+\/\d+$/.test(s)) && seen.includes("joining")) ? "pass" : "fail",
    (status?.stageLog || []).map((x) => `${x.stage} @${x.atSec}s`).join(" → ") || stages.join(" → "));

  let clipPath = null;
  if (status?.status === "ready") {
    const dl = await downloadPromise.catch(() => null);
    if (dl) {
      clipPath = path.join(OUT, dl.suggestedFilename());
      await dl.saveAs(clipPath);
      report.requestToDownloadSec = (Date.now() - exportAt) / 1000;
      check("browser downloads the joined clip", /-clip\.mp4$/.test(dl.suggestedFilename()) ? "pass" : "warn",
        `${dl.suggestedFilename()} · request→file in browser ${report.requestToDownloadSec.toFixed(1)} s`);
    } else {
      check("browser downloads the joined clip", "fail", "no download event");
    }
  }
  const panelAfter = await page.textContent('[data-testid="download-elapsed"]').catch(() => null);
  if (panelAfter) report.panelElapsed = panelAfter.trim();
  await page.screenshot({ path: path.join(OUT, "after-export.png"), fullPage: true });
  await browser.close();
  if (errors.length) check("no page errors", "fail", errors.slice(0, 3).join(" | "));

  // ── 5. The file ──
  if (clipPath) {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", clipPath]);
    const p = JSON.parse(stdout);
    const dur = Number(p.format.duration);
    const v = p.streams.find((s) => s.width);
    const codecs = p.streams.map((s) => s.codec_name).join("+");
    report.file = { duration: dur, width: v?.width, height: v?.height, codecs, bytes: fs.statSync(clipPath).size };
    check(`duration ${(TOTAL - 0.1).toFixed(1)}–${(TOTAL + 0.1).toFixed(1)} s`, Math.abs(dur - TOTAL) <= 0.1 ? "pass" : "fail", `${dur.toFixed(3)} s`);
    check(`${QUALITY}, H.264 + AAC`, v?.height === Number(QUALITY.replace("p", "")) && codecs === "h264+aac" ? "pass" : "fail",
      `${v?.width}x${v?.height} ${codecs} · ${(report.file.bytes / 1024 / 1024).toFixed(1)} MB`);

    // ── 6. Cut accuracy ──
    try {
      const ref = arg("reference") || (await pullReference(Math.max(...SEGMENTS.map((s) => s.out)) + 5));
      // The reference is RapidAPI's whole-video stream: a stream copy of
      // YouTube's DASH video, so its timestamps are YouTube's (no shift).
      // Nominal frame rate of the clip (not the job's reported fps).
      const { stdout: rf } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", clipPath]);
      const [fa, fb] = rf.trim().split("/").map(Number);
      const clipFps = fb ? fa / fb : fa || 60000 / 1001;
      const rows = await checkJoins({ clip: clipPath, segments: SEGMENTS, fps: clipFps, runFrames: 60, sourceAt: async () => ({ input: ref }) });
      report.cuts = rows;
      console.table(rows);
      // Picture and sound both: the audio must be the same audio (correlation) and in sync (±45 ms).
      check("audio matches YouTube and is in sync (±45 ms)", rows.every((r) => r.audioCorr >= 0.8 && Math.abs(r.audioLagMs) <= 45) ? "pass" : "fail",
        rows.map((r) => `#${r.segment} ${r.audioLagMs} ms (corr ${r.audioCorr})`).join(" · "));
      check("every cut lands within 1 frame of the requested time", rows.every((r) => r.pass) ? "pass" : "fail",
        rows.map((r) => `#${r.segment} ${r.frameOffset >= 0 ? "+" : ""}${r.frameOffset}f (audio ${r.audioLagMs} ms)`).join(" · "));
    } catch (e) {
      check("every cut lands within 1 frame of the requested time", "fail", `reference unavailable: ${e.message.slice(0, 200)}`);
    }
  }

  // ── 7. Render /tmp ──
  const tmp = await (await fetch(`${RENDER}/debug/tmp?match=${jobId}`)).json().catch(() => ({ files: null }));
  const leftovers = (tmp.files || []).filter((f) => /^(seg|raw|rapid-raw|gcs-src)-/.test(f.name));
  report.renderTmp = tmp.files;
  check("Render /tmp keeps no seg-*/raw-* files for the job", tmp.files && leftovers.length === 0 ? "pass" : "fail",
    tmp.files ? `${tmp.files.map((f) => f.name).join(", ") || "(nothing)"}` : "could not list");
  if (flag("wait-ttl")) {
    console.log("    waiting 31 min for the 30-min TTL...");
    await sleep(31 * 60_000);
    const later = await (await fetch(`${RENDER}/debug/tmp?match=${jobId}`)).json();
    check("Render /tmp empty for the job after the TTL", later.files.length === 0 ? "pass" : "fail", later.files.map((f) => f.name).join(", ") || "(nothing)");
  }

  // ── 8. Bunny untouched ──
  const bunnyAfter = (await bunny("/videos?page=1&itemsPerPage=1")).totalItems;
  report.bunnyAfter = bunnyAfter;
  check("Bunny library count unchanged", bunnyAfter === bunnyBefore ? "pass" : "fail", `${bunnyBefore} → ${bunnyAfter}`);
  finish(report);
}

// The source, straight from RapidAPI, streamed until it covers `needSec`.
async function pullReference(needSec) {
  const key = process.env.RAPIDAPI_KEY;
  const host = "youtube-info-download-api.p.rapidapi.com";
  const q = new URLSearchParams({ format: "720", add_info: "0", url: `https://www.youtube.com/watch?v=${VIDEO}`, allow_extended_duration: "1", no_merge: "false" });
  const init = await (await fetch(`https://${host}/ajax/download.php?${q}`, { headers: { "x-rapidapi-host": host, "x-rapidapi-key": key } })).json();
  if (!init.success) throw new Error(`RapidAPI: ${init.message}`);
  let url = null;
  for (let i = 0; i < 120 && !url; i++) {
    await sleep(5000);
    const p = await (await fetch(init.progress_url)).json().catch(() => ({}));
    if (p.success === 1 && p.download_url) url = p.download_url;
  }
  if (!url) throw new Error("RapidAPI gave no download URL");
  const file = path.join(OUT, "reference.mp4");
  console.log(`    pulling reference source from RapidAPI (until ${needSec}s)...`);
  await new Promise((resolve, reject) => {
    const c = spawn("curl", ["-fsSL", "-o", file, url]);
    let done = false;
    const timer = setInterval(async () => {
      if (!fs.existsSync(file) || fs.statSync(file).size < 2e6) return;
      try {
        const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
        if (Number(stdout) >= needSec) { done = true; c.kill(); }
      } catch {}
    }, 4000);
    c.on("exit", (code) => { clearInterval(timer); done || code === 0 ? resolve() : reject(new Error(`curl exit ${code}`)); });
  });
  return file;
}

function finish(report) {
  report.checks = checks;
  report.finishedAt = new Date().toISOString();
  report.verifierSec = (Date.now() - t0) / 1000;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const red = checks.filter((c) => c.status === "fail");
  const amber = checks.filter((c) => c.status === "warn");
  console.log(`\n${red.length ? "\x1b[31mFAILED" : "\x1b[32mALL CHECKS PASSED"}\x1b[0m — ${checks.length - red.length - amber.length} pass, ${amber.length} warn, ${red.length} fail · report ${path.relative(ROOT, OUT)}/report.json`);
  process.exit(red.length ? 1 : 0);
}

main().catch((e) => { check("verifier crashed", "fail", e.stack?.split("\n").slice(0, 3).join(" ") || String(e)); finish({}); });
