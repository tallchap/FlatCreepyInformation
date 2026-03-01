import { BigQuery } from "@google-cloud/bigquery";
import OpenAI from "openai";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function parseServiceAccount(raw = "") {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const fixed = raw.replace(
      /"private_key"\s*:\s*"([\s\S]*?)",\s*"client_email"/,
      (_m, key) =>
        `"private_key":"${String(key).replace(/\n/g, "\\n")}","client_email"`,
    );
    return JSON.parse(fixed);
  }
}

const credentials = parseServiceAccount(
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "",
);
const bigQuery = new BigQuery({ credentials, projectId: credentials.project_id });
const openai = new OpenAI();

const DEAD_PEOPLE = [
  "adolf hitler",
  "abraham lincoln",
  "winston churchill",
  "martin luther king",
  "albert einstein",
  "napoleon bonaparte",
  "joseph stalin",
  "john f kennedy",
  "jesus christ",
];

function dedupCsv(csv = "") {
  const seen = new Set();
  const out = [];
  for (const raw of csv.split(",")) {
    const n = raw.trim().replace(/\s+/g, " ");
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.join(", ");
}

function hasPromptArtifacts(s = "") {
  return /\b(the\s+name\s+is|speaker\s*:|return\s+only|output\s*:?)\b/i.test(s);
}

function isAllowedSingleTokenName(name = "") {
  const n = name.trim().toLowerCase();
  return ["will.i.am", "will i am", "william adams"].includes(n);
}

function allTwoWordOrMore(csv = "") {
  if (!csv.trim()) return true;
  return csv
    .split(",")
    .map((n) => n.trim())
    .every((n) => n.split(/\s+/).length >= 2 || isAllowedSingleTokenName(n));
}

function containsDeadName(csv = "") {
  const low = csv.toLowerCase();
  return DEAD_PEOPLE.some((d) => low.includes(d));
}

async function thirdCheck(row) {
  const transcriptSample = String(row.Search_Doc_1 || "").slice(0, 20000);
  const candidates = dedupCsv(row.Speakers_Claude || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const candidateSet = new Set(candidates.map((n) => n.toLowerCase()));
  if (candidates.length === 0) return "";

  const prompt = `Candidate list (pass 2): ${candidates.join(", ")}\nUser speaker input: ${row.User_Speakers || ""}\nVideo title: ${row.Video_Title || ""}\nChannel name: ${row.Channel_Name || "Unknown"}\nDescription (first 500 chars): ${String(row.Video_Description || "").slice(0, 500)}\n\nTranscript excerpt:\n${transcriptSample}\n\nReturn ONLY kept names from candidate list as CSV (subset only).`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are a strict final QA pass for speaker names. CRITICAL: output must be a subset of candidate list; never add names. Keep only actual speakers. Remove prompt artifacts/fragments and obvious deceased non-participants. Return only deduped CSV names. Prefer First Last; allow valid stage names from candidates such as will.i.am.",
      },
      { role: "user", content: prompt },
    ],
  });

  const cleaned = dedupCsv(resp.choices?.[0]?.message?.content || "");
  return cleaned
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n && (n.split(/\s+/).length >= 2 || isAllowedSingleTokenName(n)))
    .filter((n) => candidateSet.has(n.toLowerCase()))
    .join(", ");
}

const sampleSize = Number(process.argv[2] || 9);

const [sample] = await bigQuery.query({
  query: `
    SELECT
      ID,
      Video_Title,
      Channel_Name,
      Video_Description,
      User_Speakers,
      Extracted_Speakers,
      Speakers_Claude,
      Search_Doc_1
    FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
    WHERE Search_Doc_1 IS NOT NULL
      AND LENGTH(Search_Doc_1) > 200
      AND Speakers_Claude IS NOT NULL
      AND TRIM(Speakers_Claude) != ''
    ORDER BY RAND()
    LIMIT @sampleSize
  `,
  params: { sampleSize },
});

function toSet(csv = "") {
  return new Set(
    dedupCsv(csv)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => n.toLowerCase()),
  );
}

const results = [];
for (const r of sample) {
  const third = await thirdCheck(r);
  const pass1 = dedupCsv(r.Extracted_Speakers || "");
  const pass2 = dedupCsv(r.Speakers_Claude || "");

  const s2 = toSet(pass2);
  const s3 = toSet(third);

  const added = [...s3].filter((n) => !s2.has(n));
  const removed = [...s2].filter((n) => !s3.has(n));

  const reasonCodes = [];
  if (allTwoWordOrMore(third)) reasonCodes.push("format_ok");
  else reasonCodes.push("format_review");
  if (!hasPromptArtifacts(third)) reasonCodes.push("artifact_clean");
  else reasonCodes.push("artifact_found");
  if (removed.length > 0) reasonCodes.push("filtered_candidates");
  if (added.length === 0) reasonCodes.push("no_new_names");
  const deadBefore = containsDeadName(pass2);
  const deadAfter = containsDeadName(third);
  if (deadBefore && !deadAfter) reasonCodes.push("dead_filtered");
  else if (deadAfter) reasonCodes.push("dead_review");

  results.push({
    id: r.ID,
    title: String(r.Video_Title || "").slice(0, 52),
    youtube: `https://www.youtube.com/watch?v=${r.ID}`,
    app: `https://flat-creepy-information-cj1si7cp1-ori-nagels-projects.vercel.app/video/${r.ID}`,
    pass1,
    pass2,
    pass3: third,
    delta: `${added.length ? `+ ${added.join(", ")}` : "+ none"} / ${removed.length ? `- ${removed.join(", ")}` : "- none"}`,
    reasons: reasonCodes.join(", "),
  });
}

console.log("| Video | Links | Pass1 (Extracted) | Pass2 (Claude) | Pass3 (GPT Third) | Delta P2→P3 | Auto reasons | Human score | Notes |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  const esc = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  console.log(`| ${esc(r.id)} — ${esc(r.title)} | <${esc(r.youtube)}> / <${esc(r.app)}> | ${esc(r.pass1)} | ${esc(r.pass2)} | ${esc(r.pass3)} | ${esc(r.delta)} | ${esc(r.reasons)} | ⬜ | |`);
}
