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

function normalizeLooseName(s = "") {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function isAllowedSingleTokenName(name = "") {
  const n = normalizeLooseName(name);
  return ["will i am", "william adams", "destiny", "unknown"].includes(n);
}

function stripPromptArtifacts(text = "") {
  return text
    .replace(/\b(the\s+name\s+is|speaker\s*:?|output\s*:?|return\s+only\s*:?)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function dedupCsv(csv = "") {
  const seen = new Set();
  const out = [];
  for (const raw of csv.split(",")) {
    const n = raw.trim().replace(/\s+/g, " ");
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out.join(", ");
}

function hasSpeakerContextForName(name, title, description) {
  const n = (name || "").trim().toLowerCase();
  if (!n) return false;
  const titleDesc = `${title || ""} ${description || ""}`.toLowerCase();

  if (isAllowedSingleTokenName(n)) {
    const normMeta = normalizeLooseName(titleDesc);
    const normName = normalizeLooseName(n);
    if (normMeta.includes(normName)) return true;
  }

  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cueRegex = new RegExp(
    [
      `(?:interview|conversation|talk|fireside|podcast|debate|panel|q\\&a|q&a|hosted by|host|guest|featuring|with)\\s+${esc}`,
      `${esc}\\s+(?:interview|conversation|talk|fireside|podcast|debate|panel|guest|speaker)`,
    ].join("|"),
    "i",
  );

  return cueRegex.test(titleDesc);
}

async function pass3FromRow(openai, row) {
  const candidateList = dedupCsv(stripPromptArtifacts(row.Speakers_Claude || ""))
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (!candidateList.length) return "";

  const candidateSet = new Set(candidateList.map((n) => n.toLowerCase()));

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are a strict final QA pass for speaker names. CRITICAL: output must be a subset of candidate list; never add names. Keep only people from candidate list who are actually speaking. Remove artifacts/fragments and obvious discussed-only/deceased non-participants. Return only CSV names. Prefer First Last; allow valid stage names from candidates such as will.i.am.",
      },
      {
        role: "user",
        content: `Candidate list (pass 2): ${candidateList.join(", ")}\nUser speaker input: ${row.User_Speakers || ""}\nVideo title: ${row.Video_Title || ""}\nChannel name: ${row.Channel_Name || "Unknown"}\nDescription (first 500 chars): ${String(row.Video_Description || "").slice(0, 500)}\n\nReturn ONLY kept names as CSV (subset only).`,
      },
    ],
  });

  const cleaned = dedupCsv(stripPromptArtifacts(response.choices?.[0]?.message?.content || ""));

  const keptByModel = cleaned
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n && (n.split(/\s+/).length >= 2 || isAllowedSingleTokenName(n)))
    .filter((n) => candidateSet.has(n.toLowerCase()));

  const rescue = candidateList.filter((n) => hasSpeakerContextForName(n, row.Video_Title || "", row.Video_Description || ""));

  return dedupCsv([...keptByModel, ...rescue].join(", "));
}

const credentials = parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "");
const bigQuery = new BigQuery({ credentials, projectId: credentials.project_id });
const openai = new OpenAI();

const sampleSize = Number(process.argv[2] || 100);

const [rows] = await bigQuery.query({
  query: `
    SELECT
      ID,
      Video_Title,
      Channel_Name,
      Video_Description,
      User_Speakers,
      Speakers_Claude,
      Speakers_GPT_Third
    FROM \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
    WHERE Speakers_Claude IS NOT NULL
      AND TRIM(Speakers_Claude) != ''
    ORDER BY RAND()
    LIMIT @sampleSize
  `,
  params: { sampleSize },
});

const updated = [];
const skipped = [];

for (const row of rows) {
  try {
    const pass3 = await pass3FromRow(openai, row);
    await bigQuery.query({
      query: `
        UPDATE \`youtubetranscripts-429803.reptranscripts.youtube_transcripts\`
        SET Speakers_GPT_Third = @pass3
        WHERE ID = @id
      `,
      params: { id: row.ID, pass3 },
    });
    updated.push({ id: row.ID, p2: row.Speakers_Claude || "", p3: pass3 || "" });
    console.log(`UPDATED ${row.ID} => ${pass3}`);
  } catch (e) {
    skipped.push({ id: row.ID, error: e?.message || String(e) });
    console.error(`SKIPPED ${row.ID}: ${e?.message || e}`);
  }
}

console.log("\nSUMMARY");
console.log(`Updated: ${updated.length}`);
console.log(`Skipped: ${skipped.length}`);
console.log("UPDATED_IDS:" + updated.map((x) => x.id).join(","));
if (skipped.length) {
  console.log("SKIPPED_IDS:" + skipped.map((x) => x.id).join(","));
}
