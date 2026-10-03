// Speaker-pass model eval for src/components/transcribe/utils/utils.ts.
// Runs the real extractHumanNames → identifySpeakers → verifyAndCleanSpeakers
// chain on already-ingested videos under several SPEAKER_MODEL configs, then has
// Claude Opus judge, per candidate name, whether that person actually speaks in
// the video. Reports per-config precision/recall against the judge, agreement
// with gpt-4o, tokens, and $ per 1,000 videos.
//
// Usage:
//   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... YOUTUBE_API_KEY=... \
//   GOOGLE_APPLICATION_CREDENTIALS=... npx tsx scripts/speaker-eval/eval.ts
// Env: N=60 (videos), CONFIGS=name1,name2 (subset), OUT=results.json,
//      RUNS=runs.json (cache model outputs; rerun only judges)
// The fixture (titles, descriptions, transcript text) is cached in
// scripts/speaker-eval/fixture.json (gitignored); delete it to resample.
import fs from "fs";
import path from "path";
import { BigQuery } from "@google-cloud/bigquery";
import { Completions } from "openai/resources/chat/completions";

const here = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.join(here, "fixture.json");
const PROJECT = "youtubetranscripts-429803";
const N = Number(process.env.N || 60);

// $ per 1M tokens [input, output], from this org's own billing (2026-10).
const PRICES: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-6-luna": [0.125, 0.5],
  "gpt-5.4-mini": [0.75, 4.5],
  "gpt-5-nano": [0.05, 0.4],
};

const CONFIGS: Record<string, { model: string; effort?: string }> = {
  "gpt-4o (A)": { model: "gpt-4o" },
  "gpt-4o (B)": { model: "gpt-4o" },
  "gpt-6-luna none": { model: "gpt-6-luna", effort: "none" },
  "gpt-6-luna low": { model: "gpt-6-luna", effort: "low" },
  "gpt-4o-mini": { model: "gpt-4o-mini" },
  "gpt-5.4-mini none": { model: "gpt-5.4-mini", effort: "none" },
  "gpt-5-nano minimal": { model: "gpt-5-nano", effort: "minimal" },
  // No env overrides: whatever utils.ts ships (gpt-6-luna, low effort).
  "shipped default": { model: "" },
};

type Video = { id: string; speaker: string; title: string; channel: string; description: string; text: string };

// ── Fixture ──────────────────────────────────────────────────────────────

async function buildFixture(): Promise<Video[]> {
  const bq = new BigQuery({ projectId: PROJECT });
  // Up to 3 videos per requested speaker, deterministic order, so the sample
  // spreads across speakers instead of being all one channel.
  const [rows] = await bq.query({
    query: `
      WITH req AS (
        SELECT video_id, ANY_VALUE(speaker) AS speaker FROM \`${PROJECT}.reptranscripts.transcribe_log\`
        WHERE speaker IS NOT NULL GROUP BY video_id),
      vids AS (
        SELECT v.video_id, ANY_VALUE(v.video_title) AS title, ANY_VALUE(v.channel_name) AS channel, r.speaker
        FROM \`${PROJECT}.reptranscripts.youtube_videos\` v JOIN req r USING (video_id)
        GROUP BY v.video_id, r.speaker),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY speaker ORDER BY FARM_FINGERPRINT(video_id)) AS rn FROM vids)
      SELECT video_id, title, channel, speaker FROM ranked WHERE rn <= 3
      ORDER BY FARM_FINGERPRINT(CONCAT(video_id, "speaker-eval")) LIMIT @n`,
    params: { n: N },
  });
  const { formatTranscriptAsText } = await import("../../src/components/transcribe/utils/utils");
  const out: Video[] = [];
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const yt = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${batch.map((r: any) => r.video_id).join(",")}&key=${process.env.YOUTUBE_API_KEY}`,
    ).then((r) => r.json());
    const desc = new Map((yt.items || []).map((it: any) => [it.id, it.snippet]));
    for (const r of batch) {
      const sn: any = desc.get(r.video_id);
      if (!sn) continue; // deleted/private on YouTube
      const [segs] = await bq.query({
        query: `SELECT ANY_VALUE(start_sec) AS start, ANY_VALUE(text) AS text FROM \`${PROJECT}.reptranscripts.youtube_transcript_segments\`
                WHERE video_id = @id GROUP BY segment_index ORDER BY segment_index`,
        params: { id: r.video_id },
      });
      if (!segs.length) continue;
      const text = formatTranscriptAsText({
        transcript_data: segs.map((s: any) => ({ start: Number(s.start) || 0, text: String(s.text || ""), duration: 0 })),
      } as any);
      // identifySpeakers only reads the first 20,000 chars; keep 24K for the judge.
      out.push({ id: r.video_id, speaker: r.speaker, title: sn.title, channel: sn.channelTitle, description: sn.description || "", text: text.slice(0, 24000) });
    }
  }
  return out;
}

// ── Token accounting: wrap the SDK so the real utils.ts calls are metered ──

const usage = new Map<string, { calls: number; in: number; out: number; errors: number }>();
let currentConfig = "";
const origCreate = Completions.prototype.create;
(Completions.prototype as any).create = function (this: any, ...args: any[]) {
  const p: any = (origCreate as any).apply(this, args);
  const key = currentConfig;
  const u = usage.get(key) || { calls: 0, in: 0, out: 0, errors: 0 };
  usage.set(key, u);
  p.then(
    (r: any) => { u.calls++; u.in += r.usage?.prompt_tokens || 0; u.out += r.usage?.completion_tokens || 0; },
    () => { u.errors++; },
  );
  return p;
};

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const split = (s: string) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ── Judge ────────────────────────────────────────────────────────────────

async function judge(v: Video, names: string[]): Promise<Record<string, "yes" | "no" | "unsure">> {
  const prompt = `You are checking speaker labels for a YouTube video transcript. For each candidate name, decide whether that person is actually SPEAKING in this recording (host, guest, panelist, interviewee — their voice is in the audio). People who are only mentioned, quoted, or discussed are NOT speaking. Use the transcript, title, channel and description.

Title: ${v.title}
Channel: ${v.channel}
Description (first 1500 chars): ${v.description.slice(0, 1500)}

Transcript (first 24,000 chars):
${v.text}

Candidates: ${names.join(" | ")}

Answer with JSON only: {"<exact candidate name>": "yes" | "no" | "unsure", ...}`;
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    }).then((r) => r.json());
    const txt = r.content?.find((c: any) => c.type === "text")?.text || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) try { return JSON.parse(m[0]); } catch {}
    last = r.error ? `${r.error.type}: ${r.error.message}` : `unparseable: ${txt.slice(0, 200)}`;
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  throw new Error(`judge failed for ${v.id}: ${last}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  let videos: Video[];
  if (fs.existsSync(FIXTURE)) videos = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  else { videos = await buildFixture(); fs.writeFileSync(FIXTURE, JSON.stringify(videos)); }
  console.log(`${videos.length} videos, ${new Set(videos.map((v) => v.speaker)).size} requested speakers`);

  const { extractHumanNames, identifySpeakers, verifyAndCleanSpeakers } = await import("../../src/components/transcribe/utils/utils");
  const only = process.env.CONFIGS ? new Set(process.env.CONFIGS.split(",")) : null;
  // RUNS=path reuses model outputs + token counts from an earlier run (judge-only rerun).
  const RUNS = process.env.RUNS;
  const cached = RUNS && fs.existsSync(RUNS) ? JSON.parse(fs.readFileSync(RUNS, "utf8")) : null;
  const outputs: Record<string, Record<string, { names: string; first: string; final: string }>> = cached?.outputs || {};
  if (cached) for (const [k, u] of Object.entries(cached.usage)) usage.set(k, u as any);

  for (const [name, cfg] of Object.entries(CONFIGS)) {
    if ((only && !only.has(name)) || outputs[name]) continue;
    if (cfg.model) process.env.SPEAKER_MODEL = cfg.model; else delete process.env.SPEAKER_MODEL;
    if (cfg.effort) process.env.SPEAKER_REASONING_EFFORT = cfg.effort; else delete process.env.SPEAKER_REASONING_EFFORT;
    currentConfig = name;
    const t = Date.now();
    const res = await pool(videos, 8, async (v) => {
      const names = await extractHumanNames(v.speaker, v.title, v.description);
      const first = await identifySpeakers(v.text, v.title, v.description, v.speaker, v.channel);
      const final = await verifyAndCleanSpeakers(v.text, v.title, v.description, v.speaker, first || "", v.channel);
      return [v.id, { names, first, final: final || first || "" }] as const;
    });
    outputs[name] = Object.fromEntries(res);
    await new Promise((r) => setTimeout(r, 200)); // let the last usage promises settle
    console.log(`  ran ${name} in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  }

  if (RUNS) fs.writeFileSync(RUNS, JSON.stringify({ outputs, usage: Object.fromEntries(usage) }));

  // Judge every name any config put in the final speaker list.
  const verdicts: Record<string, Record<string, string>> = {};
  await pool(videos, 3, async (v) => {
    const cands = new Map<string, string>();
    for (const o of Object.values(outputs)) for (const n of split(o[v.id].final)) cands.set(norm(n), n);
    if (!cands.size) { verdicts[v.id] = {}; return; }
    const j = await judge(v, [...cands.values()]);
    verdicts[v.id] = Object.fromEntries(Object.entries(j).map(([k, val]) => [norm(k), val]));
  });

  const base = Object.keys(outputs)[0];
  const rows: any[] = [];
  for (const [name, out] of Object.entries(outputs)) {
    let tp = 0, fp = 0, unsure = 0, agree = 0, possible = 0;
    const misses: string[] = [];
    for (const v of videos) {
      const mine = new Set(split(out[v.id].final).map(norm));
      const truth = Object.entries(verdicts[v.id] || {}).filter(([, x]) => x === "yes").map(([k]) => k);
      possible += truth.length;
      for (const n of mine) {
        const x = verdicts[v.id]?.[n];
        if (x === "yes") tp++; else if (x === "no") { fp++; misses.push(`${v.id} +${n}`); } else unsure++;
      }
      for (const n of truth) if (!mine.has(n)) misses.push(`${v.id} -${n}`);
      const b = new Set(split(outputs[base][v.id].final).map(norm));
      if (b.size === mine.size && [...b].every((x) => mine.has(x))) agree++;
    }
    const u = usage.get(name) || { calls: 0, in: 0, out: 0, errors: 0 };
    const price = PRICES[CONFIGS[name].model || "gpt-6-luna"] || [NaN, NaN];
    const cost = (u.in * price[0] + u.out * price[1]) / 1e6;
    rows.push({
      config: name,
      precision: tp / Math.max(1, tp + fp),
      recall: tp / Math.max(1, possible),
      falseSpeakers: fp,
      missedSpeakers: possible - tp,
      unsure,
      agreeWithBase: `${agree}/${videos.length}`,
      calls: u.calls,
      errors: u.errors,
      tokensIn: u.in,
      tokensOut: u.out,
      usdPer1000Videos: (cost / videos.length) * 1000,
      misses,
    });
  }
  console.log(`\nJudge: claude-opus-5-5. Base for agreement: ${base}\n`);
  console.log("config                 prec   recall  falseSpk  missed  agree   in-tok   out-tok   $/1k videos  errors");
  for (const r of rows)
    console.log(
      `${r.config.padEnd(22)} ${(r.precision * 100).toFixed(1).padStart(5)}%  ${(r.recall * 100).toFixed(1).padStart(5)}%  ${String(r.falseSpeakers).padStart(8)}  ${String(r.missedSpeakers).padStart(6)}  ${r.agreeWithBase.padStart(6)}  ${String(r.tokensIn).padStart(7)}  ${String(r.tokensOut).padStart(8)}  ${r.usdPer1000Videos.toFixed(2).padStart(11)}  ${r.errors}`,
    );
  for (const r of rows) if (r.misses.length) console.log(`\n${r.config} misses (+ false speaker, - missed):\n  ${r.misses.join("\n  ")}`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ rows, outputs, verdicts }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
