#!/usr/bin/env node
/**
 * Video Research Tool — Apify YouTube Search + AI Scoring + Dedup
 *
 * Usage:
 *   node scripts/video-research/search.mjs "Jaan Tallinn" --after 2025-01-01 --before 2025-12-31
 */

import { config } from "dotenv";
import { BigQuery } from "@google-cloud/bigquery";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

config({ path: ".env.local" });

const __dirname = dirname(fileURLToPath(import.meta.url));
const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!APIFY_TOKEN) { console.error("Missing APIFY_API_TOKEN or APIFY_TOKEN in .env.local"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

// BigQuery setup
const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
let credentials;
try { credentials = JSON.parse(credJson); } catch {
  const fixed = credJson.replace(
    /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
    (_m, key) => `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
  );
  credentials = JSON.parse(fixed);
}
const bigquery = new BigQuery({ credentials, projectId: credentials.project_id });
const PROJECT = credentials.project_id;
const DATASET = "reptranscripts";

// ─── Parse CLI args ──────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: node search.mjs <speaker> [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--min-duration 3]");
    process.exit(1);
  }
  const speaker = args[0];
  const opts = { after: null, before: null, minDuration: 3 };
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === "--after") opts.after = args[i + 1];
    else if (args[i] === "--before") opts.before = args[i + 1];
    else if (args[i] === "--min-duration") opts.minDuration = parseInt(args[i + 1]);
  }
  return { speaker, ...opts };
}

// ─── Apify YouTube Search ────────────────────────────────────────────────────
async function runApifySearch(keyword) {
  console.log(`  Apify search: "${keyword}"...`);

  // Start the run (don't wait for finish)
  const res = await fetch(
    `https://api.apify.com/v2/acts/streamers~youtube-scraper/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchKeywords: keyword,
        maxResults: 50,
      }),
    }
  );
  const run = await res.json();
  const runId = run.data?.id;
  if (!runId) {
    console.error(`  Failed to start Apify run for "${keyword}"`);
    return [];
  }

  // Poll until done (max 5 min)
  const maxWait = 300_000;
  const start = Date.now();
  let status = "";
  let datasetId = "";

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const pollData = await pollRes.json();
    status = pollData.data?.status || "";
    datasetId = pollData.data?.defaultDatasetId || "";
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r    Waiting... ${elapsed}s (${status})`);
    if (status === "SUCCEEDED" || status === "FAILED" || status === "ABORTED") break;
  }
  console.log(); // newline after \r

  if (status !== "SUCCEEDED") {
    console.error(`  Apify run ${status} for "${keyword}"`);
    return [];
  }

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json`
  );
  const items = await itemsRes.json();
  console.log(`  → ${items.length} results`);
  return items;
}

function parseDurationStr(dur) {
  // Apify returns "HH:MM:SS" or "MM:SS"
  if (!dur) return 0;
  const parts = dur.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

async function searchApify(speaker) {
  const queries = [
    `"${speaker}" interview`,
    `"${speaker}" podcast`,
    `"${speaker}" keynote`,
    speaker,
    `"${speaker}" panel`,
  ];

  const allResults = new Map(); // videoId -> candidate

  for (const q of queries) {
    try {
      const items = await runApifySearch(q);
      for (const item of items) {
        const vid = item.id;
        if (!vid || allResults.has(vid)) continue;
        allResults.set(vid, {
          videoId: vid,
          title: item.title || "",
          channel: item.channelName || "",
          channelId: item.channelId || "",
          description: item.text || "",
          publishedAt: item.date ? item.date.split("T")[0] : null,
          thumbnail: item.thumbnailUrl || "",
          durationSeconds: parseDurationStr(item.duration),
          viewCount: item.viewCount || 0,
        });
      }
    } catch (err) {
      console.error(`  Error on "${q}": ${err.message}`);
    }
  }

  console.log(`  Found ${allResults.size} unique videos across ${queries.length} queries.`);
  return [...allResults.values()];
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// ─── BigQuery Dedup ──────────────────────────────────────────────────────────
async function getExistingVideoIds() {
  const [rows] = await bigquery.query({
    query: `SELECT DISTINCT video_id FROM \`${PROJECT}.${DATASET}.youtube_videos\``,
  });
  return new Set(rows.map((r) => r.video_id));
}

// ─── Transcript-based overlap dedup ──────────────────────────────────────────
const TRANSCRIPT_SERVICE = "https://afraid-sparkling-planes.vercel.app/transcript";

async function fetchTranscript(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(TRANSCRIPT_SERVICE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.transcript_data || []).map((s) => s.text).join(" ");
  } catch {
    return null;
  }
}

function extract5WordPhrases(text) {
  const words = text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
  const phrases = new Set();
  for (let i = 0; i <= words.length - 5; i++) {
    phrases.add(words.slice(i, i + 5).join(" "));
  }
  return phrases;
}

function computeOverlap(phrasesA, phrasesB) {
  let overlap = 0;
  const smaller = phrasesA.size < phrasesB.size ? phrasesA : phrasesB;
  const larger = phrasesA.size < phrasesB.size ? phrasesB : phrasesA;
  for (const p of smaller) {
    if (larger.has(p)) overlap++;
  }
  return smaller.size > 0 ? overlap / smaller.size : 0;
}

async function transcriptDedup(candidates) {
  console.log("\n[3] Transcript-based dedup...");
  console.log(`  Fetching transcripts for ${candidates.length} candidates...`);

  const transcripts = new Map();
  let fetched = 0;
  for (const c of candidates) {
    const text = await fetchTranscript(c.videoId);
    if (text && text.length > 50) {
      transcripts.set(c.videoId, extract5WordPhrases(text));
    }
    fetched++;
    if (fetched % 10 === 0) console.log(`  ${fetched}/${candidates.length} transcripts fetched...`);
  }
  console.log(`  Got transcripts for ${transcripts.size}/${candidates.length} videos.`);

  const droppedIds = new Set();
  const videoList = candidates.filter((c) => transcripts.has(c.videoId));

  for (let i = 0; i < videoList.length; i++) {
    if (droppedIds.has(videoList[i].videoId)) continue;
    for (let j = i + 1; j < videoList.length; j++) {
      if (droppedIds.has(videoList[j].videoId)) continue;
      const phrasesA = transcripts.get(videoList[i].videoId);
      const phrasesB = transcripts.get(videoList[j].videoId);
      const overlap = computeOverlap(phrasesA, phrasesB);
      if (overlap > 0.2) {
        const shorter = videoList[i].durationSeconds <= videoList[j].durationSeconds
          ? videoList[i] : videoList[j];
        const longer = shorter === videoList[i] ? videoList[j] : videoList[i];
        console.log(`  Overlap ${(overlap * 100).toFixed(0)}%: "${shorter.title}" is clip of "${longer.title}" — dropping shorter.`);
        droppedIds.add(shorter.videoId);
      }
    }
  }

  const result = candidates.filter((c) => !droppedIds.has(c.videoId));
  console.log(`  Kept ${result.length} after transcript dedup (dropped ${droppedIds.size}).`);
  return result;
}

// ─── Rules Engine ────────────────────────────────────────────────────────────
function loadRules() {
  try {
    return JSON.parse(readFileSync(join(__dirname, "rules.json"), "utf-8"));
  } catch {
    return { version: 1, global_rules: { reject_channels: [], reject_title_patterns: [], boost_channels: [], boost_title_patterns: [] }, speaker_rules: {} };
  }
}

function applyRules(candidates, rules, speaker) {
  const global = rules.global_rules || {};
  const speakerRules = rules.speaker_rules?.[speaker] || {};

  const rejectChannels = [...(global.reject_channels || []), ...(speakerRules.reject_channels || [])];
  const rejectTitles = [...(global.reject_title_patterns || []), ...(speakerRules.reject_title_patterns || [])];
  const boostChannels = [...(global.boost_channels || []), ...(speakerRules.boost_channels || [])];
  const boostTitles = [...(global.boost_title_patterns || []), ...(speakerRules.boost_title_patterns || [])];

  return candidates.map((c) => {
    for (const rule of rejectChannels) {
      if (new RegExp(rule.pattern, "i").test(c.channel)) {
        return { ...c, _rejected: true, _rejectRule: `channel:${rule.pattern}` };
      }
    }
    for (const rule of rejectTitles) {
      if (new RegExp(rule.pattern, "i").test(c.title)) {
        return { ...c, _rejected: true, _rejectRule: `title:${rule.pattern}` };
      }
    }

    let boost = 0;
    const matchedRules = [];
    for (const rule of boostChannels) {
      if (new RegExp(rule.pattern, "i").test(c.channel)) {
        boost += rule.boost;
        matchedRules.push(`+${rule.boost} channel:${rule.pattern}`);
      }
    }
    for (const rule of boostTitles) {
      if (new RegExp(rule.pattern, "i").test(c.title)) {
        boost += rule.boost;
        matchedRules.push(`+${rule.boost} title:${rule.pattern}`);
      }
    }

    return { ...c, _boost: boost, _matchedRules: matchedRules };
  }).filter((c) => {
    if (c._rejected) {
      console.log(`  Rule rejected: "${c.title}" (${c._rejectRule})`);
      return false;
    }
    return true;
  });
}

// ─── AI Scoring ──────────────────────────────────────────────────────────────
async function scoreWithAI(candidates, speaker) {
  console.log(`\n[5] AI scoring ${candidates.length} candidates with gpt-5.4-2026-03-05...`);
  const BATCH_SIZE = 20;
  const scored = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    console.log(`  Scoring batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(candidates.length / BATCH_SIZE)} (${batch.length} videos)...`);

    const videosJson = batch.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      channel: v.channel,
      description: (v.description || "").slice(0, 8000),
      duration: formatDuration(v.durationSeconds),
      publishedAt: v.publishedAt,
    }));

    const prompt = `You are evaluating YouTube search results to determine if a specific person is likely an ACTUAL PARTICIPANT (speaking/being interviewed) in each video, not merely discussed or mentioned.

Speaker we're looking for: ${speaker}

For each video below, return a JSON array where each element has:
- videoId: the video ID
- confidence: 0-100 (how confident the speaker is actually IN the video as a participant)
- reasoning: one sentence explaining your confidence
- red_flags: array of concerns (empty if none)
- category: one of "interview" | "podcast" | "keynote" | "panel" | "lecture" | "news_clip" | "compilation" | "reaction" | "other"

Scoring guidance:
- 90-100: Title explicitly names them as guest/speaker + reputable interview channel
- 70-89: Strong contextual evidence they're present (known channel, interview framing)
- 50-69: Possible but uncertain (name in title but unclear role)
- 30-49: Unlikely (news coverage about them, reaction videos)
- 0-29: Almost certainly not present (clearly about them, not featuring them)

Return valid JSON with a "videos" key containing the array, e.g. {"videos": [...]}

Videos to evaluate:
${JSON.stringify(videosJson, null, 2)}`;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-5.4-2026-03-05",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`  OpenAI API error: ${res.status} ${errText.slice(0, 200)}`);
        for (const v of batch) {
          scored.push({ ...v, confidence: heuristicScore(v, speaker), reasoning: "Heuristic (API error)", red_flags: [], category: "other" });
        }
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";

      let scores;
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          scores = parsed;
        } else {
          scores = parsed.videos || parsed.results || parsed.evaluations;
          if (!scores) {
            for (const val of Object.values(parsed)) {
              if (Array.isArray(val)) { scores = val; break; }
            }
          }
        }
        if (!Array.isArray(scores)) throw new Error("Could not find array in response");
      } catch (parseErr) {
        console.error(`  JSON parse failed: ${parseErr.message}`);
        for (const v of batch) {
          scored.push({ ...v, confidence: heuristicScore(v, speaker), reasoning: "Heuristic (parse error)", red_flags: [], category: "other" });
        }
        continue;
      }

      for (const score of scores) {
        const candidate = batch.find((c) => c.videoId === score.videoId);
        if (candidate) {
          const totalConfidence = Math.min(100, (score.confidence || 0) + (candidate._boost || 0));
          scored.push({
            ...candidate,
            confidence: totalConfidence,
            reasoning: score.reasoning || "",
            red_flags: score.red_flags || [],
            category: score.category || "other",
          });
        }
      }
    } catch (err) {
      console.error(`  Scoring error: ${err.message}`);
      for (const v of batch) {
        scored.push({ ...v, confidence: heuristicScore(v, speaker), reasoning: "Heuristic (exception)", red_flags: [], category: "other" });
      }
    }
  }

  return scored
    .filter((v) => v.confidence >= 40)
    .sort((a, b) => b.confidence - a.confidence);
}

function heuristicScore(video, speaker) {
  const title = (video.title || "").toLowerCase();
  const speakerLower = speaker.toLowerCase();
  if (title.includes(speakerLower) && /interview|podcast|conversation|chat|talk/i.test(title)) return 60;
  if (title.includes(speakerLower)) return 45;
  return 30;
}

// ─── BigQuery Write ──────────────────────────────────────────────────────────
async function writeResults(runId, speaker, opts, rawCount, candidates) {
  const runsTable = `${PROJECT}.${DATASET}.research_runs`;

  await bigquery.query({
    query: `INSERT INTO \`${runsTable}\` (run_id, speaker, date_after, date_before, query_variants, total_raw, total_scored, created_at)
            VALUES (@runId, @speaker, @dateAfter, @dateBefore, @queries, @totalRaw, @totalScored, CURRENT_TIMESTAMP())`,
    params: {
      runId,
      speaker,
      dateAfter: opts.after || null,
      dateBefore: opts.before || null,
      queries: [
        `"${speaker}" interview`, `"${speaker}" podcast`, `"${speaker}" keynote`,
        speaker, `"${speaker}" panel`,
      ],
      totalRaw: rawCount,
      totalScored: candidates.length,
    },
  });

  if (candidates.length === 0) return;

  const table = bigquery.dataset(DATASET).table("research_candidates");
  const rows = candidates.map((c) => ({
    run_id: runId,
    video_id: c.videoId,
    title: c.title || "",
    channel: c.channel || "",
    channel_id: c.channelId || "",
    duration_seconds: c.durationSeconds || 0,
    published_at: c.publishedAt || "",
    description: (c.description || "").slice(0, 5000),
    thumbnail_url: c.thumbnail || "",
    confidence: c.confidence || 0,
    reasoning: c.reasoning || "",
    red_flags: c.red_flags?.length ? c.red_flags : [],
    category: c.category || "other",
    matched_rules: c._matchedRules?.length ? c._matchedRules : [],
    status: "pending",
  }));

  for (let i = 0; i < rows.length; i += 500) {
    await table.insert(rows.slice(i, i + 500));
  }

  console.log(`  Wrote ${candidates.length} candidates to BigQuery.`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const { speaker, after, before, minDuration } = parseArgs();
  const runId = randomUUID();

  console.log(`\n=== Video Research: "${speaker}" (Apify) ===`);
  console.log(`Date range: ${after || "any"} to ${before || "any"}`);
  console.log(`Min duration: ${minDuration} minutes`);
  console.log(`Run ID: ${runId}\n`);

  // Step 1: Apify search (5 queries)
  console.log("[1] Searching YouTube via Apify...");
  let candidates = await searchApify(speaker);
  const totalRaw = candidates.length;

  // Step 1b: Filter by duration
  candidates = candidates.filter((c) => c.durationSeconds >= minDuration * 60);
  console.log(`  ${candidates.length} videos >= ${minDuration} min.`);

  // Step 1c: Filter by date range
  if (after || before) {
    const beforeCount = candidates.length;
    candidates = candidates.filter((c) => {
      if (!c.publishedAt) return true;
      if (after && c.publishedAt < after) return false;
      if (before && c.publishedAt > before) return false;
      return true;
    });
    console.log(`  ${candidates.length} videos in date range (filtered ${beforeCount - candidates.length}).`);
  }

  // Step 2: BigQuery dedup
  console.log("\n[2] Checking BigQuery for existing videos...");
  const existingIds = await getExistingVideoIds();
  const beforeDedup = candidates.length;
  candidates = candidates.filter((c) => !existingIds.has(c.videoId));
  console.log(`  Removed ${beforeDedup - candidates.length} already in database. ${candidates.length} remaining.`);

  if (candidates.length === 0) {
    console.log("\nNo new candidates found.");
    await writeResults(runId, speaker, { after, before }, totalRaw, []);
    return;
  }

  // Step 3: Transcript-based dedup
  candidates = await transcriptDedup(candidates);

  // Step 4: Apply rules
  console.log("\n[4] Applying rules...");
  const rules = loadRules();
  candidates = applyRules(candidates, rules, speaker);
  console.log(`  ${candidates.length} candidates after rules.`);

  // Step 5: AI scoring
  candidates = await scoreWithAI(candidates, speaker);
  console.log(`\n${candidates.length} candidates scored >= 40 confidence.`);

  // Step 6: Write to BigQuery
  console.log("\n[6] Writing results to BigQuery...");
  await writeResults(runId, speaker, { after, before }, totalRaw, candidates);

  // Print summary
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  RESULTS: ${candidates.length} candidates for "${speaker}"`);
  console.log(`  Run ID: ${runId}`);
  console.log(`${"═".repeat(70)}\n`);

  for (const c of candidates) {
    console.log(`  [${c.confidence}] ${c.title}`);
    console.log(`       ${c.channel} | ${formatDuration(c.durationSeconds)} | ${c.publishedAt}`);
    console.log(`       ${c.reasoning}`);
    if (c.red_flags?.length) console.log(`       Red flags: ${c.red_flags.join(", ")}`);
    console.log();
  }

  console.log(`Open the vetting UI: http://localhost:3001/research?runId=${runId}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
