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
  const prompt = `User speaker input: ${row.User_Speakers || ""}\nPrior identified speakers: ${row.Speakers_Claude || ""}\nVideo title: ${row.Video_Title || ""}\nChannel name: ${row.Channel_Name || "Unknown"}\nDescription (first 500 chars): ${String(row.Video_Description || "").slice(0, 500)}\n\nTranscript excerpt:\n${transcriptSample}\n\nReturn ONLY the cleaned CSV list of speakers.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are a strict final QA pass for speaker names. Keep only actual speakers in the video. Remove prompt artifacts/fragments. Remove obvious deceased historical figures clearly discussed but not present. Output ONLY real human names in CSV format. Each name must be First Last (middle allowed). No single-word names, no titles, no organizations. Deduplicate. If uncertain, exclude.",
      },
      { role: "user", content: prompt },
    ],
  });

  const cleaned = dedupCsv(resp.choices?.[0]?.message?.content || "");
  return cleaned
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n && n.split(/\s+/).length >= 2)
    .join(", ");
}

const [rows] = await bigQuery.query({
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
    ORDER BY Created_Time DESC
    LIMIT 40
  `,
});

// sample 8 from the recent 40 for speed/cost balance
const sample = rows.sort(() => Math.random() - 0.5).slice(0, 8);

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
