import fs from "fs";
// Filter-detection eval for src/app/api/chat/route.ts detectFilters.
// Reads the prompt template straight from the route, runs 18 questions against
// real Eliezer Yudkowsky channel/co-speaker lists (filter_ctx.json, BigQuery
// snapshot 2026-10-02), and scores each model config.
// Usage: OPENAI_API_KEY=... node scripts/filter-eval/eval.mjs
//        ONLY_SHIPPED=1 REPS=3 ... to test just the shipped config. Exits 1 on any miss.
import path from "path";
import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const K = process.env.OPENAI_API_KEY;
const ctx = JSON.parse(fs.readFileSync(path.join(here, "filter_ctx.json")))["Eliezer Yudkowsky"];
const speakerName = "Eliezer Yudkowsky";
// exact production prompt template (src/app/api/chat/route.ts detectFilters)
// prompt is read from the real route so the eval tests the shipped template
const route = fs.readFileSync(path.join(here, "../../src/app/api/chat/route.ts"), "utf8");
const tpl = route.slice(route.indexOf("const systemPrompt = `") + "const systemPrompt = ".length, route.indexOf("`;", route.indexOf("const systemPrompt = `")) + 1);
const sysFor = new Function("speakerName", "ctx", "message", "return " + tpl).bind(null, speakerName, ctx);

// expected: each check is a predicate on parsed filters. Alternatives where channel/co-speaker are both valid.
const F = ["channel","coSpeaker","excludeChannel","excludeCoSpeaker","yearBefore","yearAfter"];
const only = (want) => (p) => F.every(k => (want[k] ?? null) === (p[k] ?? null));
const any = (...preds) => (p) => preds.some(f => f(p));
const cases = [
  ["what does he think about consciousness", only({})],
  ["what did he say on lex fridman about AI boxing", any(only({channel:"Lex Fridman"}), only({coSpeaker:"Lex Fridman"}), only({channel:"Lex Fridman",coSpeaker:"Lex Fridman"}))],
  ["his debate with george hotz", only({coSpeaker:"George Hotz"})],
  ["anything with gary markus about LLMs", only({coSpeaker:"Gary Marcus"})],
  ["what did he say before 2020 about timelines", only({yearBefore:2020})],
  ["interviews after 2023 that aren't on bankless", only({yearAfter:2023, excludeChannel:"Bankless"})],
  ["non-lex interviews about doom", any(only({excludeCoSpeaker:"Lex Fridman"}), only({excludeChannel:"Lex Fridman"}), only({excludeChannel:"Lex Fridman",excludeCoSpeaker:"Lex Fridman"}))],
  ["on the nonzero podcast, what about moral realism", only({channel:"Nonzero"})],
  ["what did he tell ezra klein", any(only({coSpeaker:"Ezra Klein"}), only({channel:"The Ezra Klein Show"}), only({channel:"The Ezra Klein Show",coSpeaker:"Ezra Klein"}))],
  ["what did he say to dwarkesh about orthogonality", any(only({coSpeaker:"Dwarkesh Patel"}), only({channel:"Dwarkesh Patel"}), only({channel:"Dwarkesh Patel",coSpeaker:"Dwarkesh Patel"}))],
  ["not with sam harris — what does he say about evolution", only({excludeCoSpeaker:"Sam Harris"})],
  ["everything except hard fork", only({excludeChannel:"Hard Fork"})],
  ["talks posted on MIRI's channel", only({channel:"Machine Intelligence Research Institute"})],
  ["what has he said since 2024 with liron", any(only({yearAfter:2023, coSpeaker:"Liron Shapira"}), only({yearAfter:2023, channel:"Liron Shapira"}), only({yearAfter:2023, channel:"Liron Shapira", coSpeaker:"Liron Shapira"}))],
  ["robin hanson foom debate", only({coSpeaker:"Robin Hanson"})],
  ["what did he say about nvidia", only({})],
  ["from 2022 on, what has he said about LLMs", only({yearAfter:2021})],
  ["up until 2019, his views on decision theory", only({yearBefore:2020})],
];
const configs = process.env.ONLY_SHIPPED ? { "gpt-6-luna effort=none (shipped prompt)": { model: "gpt-6-luna", reasoning_effort: "none" } } : {
  "gpt-4o-mini (old)": { model: "gpt-4o-mini", temperature: 0 },
  "gpt-6-luna effort=none": { model: "gpt-6-luna", reasoning_effort: "none" },
  "gpt-6-luna effort=low": { model: "gpt-6-luna", reasoning_effort: "low" },
  "gpt-6-luna default": { model: "gpt-6-luna" },
};
const REPS = Number(process.env.REPS || 2);
async function call(cfg, msg) {
  const t = Date.now();
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${K}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...cfg, messages: [{ role: "system", content: sysFor(msg) }, { role: "user", content: "Complete the JSON above." }], response_format: { type: "json_object" } }) });
  const j = await r.json(); const ms = Date.now() - t;
  if (j.error) return { ms, err: j.error.message };
  const raw = j.choices[0].message.content || "{}";
  const jsonStr = raw.trimStart().startsWith("{") ? raw : `{"userMessage":"","channel":${raw}`;
  let parsed; try { parsed = JSON.parse(jsonStr); } catch (e) { return { ms, err: "parse: " + raw.slice(0, 80) }; }
  const p = { channel: parsed.channel || null, coSpeaker: parsed.coSpeaker || null, excludeChannel: parsed.excludeChannel || null, excludeCoSpeaker: parsed.excludeCoSpeaker || null,
    yearBefore: parsed.yearBefore ? Number(parsed.yearBefore) : null, yearAfter: parsed.yearAfter ? Number(parsed.yearAfter) : null };
  return { ms, p, usage: j.usage };
}
const results = {};
for (const [name, cfg] of Object.entries(configs)) {
  const rows = [];
  for (let rep = 0; rep < REPS; rep++) {
    const out = await Promise.all(cases.map(([msg, ok]) => call(cfg, msg).then(r => ({ msg, ...r, pass: !r.err && ok(r.p) }))));
    rows.push(...out);
  }
  const lat = rows.map(r => r.ms).sort((a, b) => a - b);
  results[name] = { pass: rows.filter(r => r.pass).length, total: rows.length, p50: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)],
    fails: rows.filter(r => !r.pass).map(r => ({ msg: r.msg, got: r.err || r.p })) };
  console.log(name, `${results[name].pass}/${results[name].total}`, `p50 ${results[name].p50}ms p90 ${results[name].p90}ms`);
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
for (const [name, r] of Object.entries(results)) for (const f of r.fails) console.log(`  MISS [${name}] ${f.msg} -> ${JSON.stringify(f.got)}`);
if (process.env.ONLY_SHIPPED && Object.values(results).some(r => r.pass < r.total)) process.exit(1);
