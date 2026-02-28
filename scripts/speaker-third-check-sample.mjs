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

function allTwoWordOrMore(csv = "") {
  if (!csv.trim()) return true;
  return csv
    .split(",")
    .map((n) => n.trim())
    .every((n) => n.split(/\s+/).length >= 2);
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
          "You are a strict final QA pass for speaker names. CRITICAL: output must be a subset of candidate list; never add names. Keep only actual speakers. Remove prompt artifacts/fragments and obvious deceased non-participants. Return only CSV names, First Last (middle allowed), deduped.",
      },
      { role: "user", content: prompt },
    ],
  });

  const cleaned = dedupCsv(resp.choices?.[0]?.message?.content || "");
  return cleaned
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n && n.split(/\s+/).length >= 2)
    .filter((n) => candidateSet.has(n.toLowerCase()))
    .join(", ");
}

const [sample] = await bigQuery.query({
  query: `
    SELECT
      ID,
      Video_Title,
      Channel_Name,
      Video_Description,
      User_Speakers,
      Speakers_Claude,
      Search_Doc_1
    FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
    WHERE Search_Doc_1 IS NOT NULL
      AND LENGTH(Search_Doc_1) > 200
      AND Speakers_Claude IS NOT NULL
      AND TRIM(Speakers_Claude) != ''
    ORDER BY RAND()
    LIMIT 9
  `,
});

const results = [];
for (const r of sample) {
  const third = await thirdCheck(r);
  const evalNotes = [];
  if (allTwoWordOrMore(third)) evalNotes.push("format_ok");
  else evalNotes.push("format_review");

  if (!hasPromptArtifacts(third)) evalNotes.push("artifact_clean");
  else evalNotes.push("artifact_found");

  const deadBefore = containsDeadName(r.Speakers_Claude || "");
  const deadAfter = containsDeadName(third || "");
  if (deadBefore && !deadAfter) evalNotes.push("dead_filtered");
  else if (deadAfter) evalNotes.push("dead_review");

  results.push({
    id: r.ID,
    title: String(r.Video_Title || "").slice(0, 42),
    pass2: dedupCsv(r.Speakers_Claude || ""),
    pass3: third,
    evaluation: evalNotes.join(" | "),
  });
}

console.log("| Video ID | Title | Pass2 (Speakers_Claude) | Pass3 (Speakers_GPT_Third) | Evaluation |");
console.log("|---|---|---|---|---|");
for (const r of results) {
  const esc = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  console.log(`| ${esc(r.id)} | ${esc(r.title)} | ${esc(r.pass2)} | ${esc(r.pass3)} | ${esc(r.evaluation)} |`);
}
