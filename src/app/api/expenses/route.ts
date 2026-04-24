import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROVIDER_TIMEOUT_MS = 10_000;

function fetchT(url: string, init?: RequestInit, ms = PROVIDER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function withTimeout<T>(p: Promise<T>, ms = PROVIDER_TIMEOUT_MS, label = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); },
           (e) => { clearTimeout(t); reject(e); });
  });
}

const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const BUNNY_KEY = process.env.BUNNY_ACCOUNT_API_KEY || "";
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const OPENAI_ADMIN_KEY = process.env.OPENAI_ADMIN_KEY || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY || "";
const VIZARD_KEY = process.env.VIZARD_API_KEY || "";

type ProviderData = {
  name: string;
  status: string;
  monthlyCost: number;
  metrics: { label: string; value: string; type?: string }[];
  bar?: { pct: number };
  link?: string;
};

const errorCard = (name: string, monthlyCost = 0, msg = "API failed or timed out", link?: string): ProviderData => ({
  name, status: "error", monthlyCost,
  metrics: [{ label: "Error", value: msg }],
  ...(link ? { link } : {}),
});

async function getApify(): Promise<ProviderData> {
  try {
    const [monthlyRes, runsRes] = await Promise.all([
      fetchT(`https://api.apify.com/v2/users/me/usage/monthly?token=${APIFY_TOKEN}`),
      fetchT(`https://api.apify.com/v2/actor-runs?token=${APIFY_TOKEN}&limit=1000&desc=1`),
    ]);
    const monthlyData = (await monthlyRes.json()).data;
    const runsData = (await runsRes.json()).data?.items || [];

    let total = 0;
    for (const [, v] of Object.entries(monthlyData.monthlyServiceUsage) as any) {
      total += v.amountAfterVolumeDiscountUsd || 0;
    }

    const daily: Record<string, { count: number; cost: number }> = {};
    for (const r of runsData) {
      const date = (r.startedAt || "").slice(0, 10);
      if (!date) continue;
      if (!daily[date]) daily[date] = { count: 0, cost: 0 };
      daily[date].count += 1;
      daily[date].cost += r.usageTotalUsd || 0;
    }
    const dailyMetrics = Object.entries(daily)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 7)
      .map(([date, d]) => ({ label: `${date} (${d.count} runs)`, value: `$${d.cost.toFixed(2)}`, type: "cost" }));

    return {
      name: "Apify", status: "ok", monthlyCost: total,
      metrics: [
        { label: "Cycle", value: `${monthlyData.usageCycle.startAt.slice(0, 10)} → ${monthlyData.usageCycle.endAt.slice(0, 10)}` },
        { label: "This cycle total", value: `$${total.toFixed(2)}`, type: "cost" },
        ...dailyMetrics,
      ],
      link: "https://console.apify.com/billing",
    };
  } catch { return errorCard("Apify"); }
}

async function getOpenAI(): Promise<ProviderData> {
  try {
    const start = Math.floor(Date.now() / 1000) - 30 * 86400;
    const end = Math.floor(Date.now() / 1000);
    const res = await fetchT(`https://api.openai.com/v1/organization/costs?start_time=${start}&end_time=${end}&bucket_width=1d&limit=30`, {
      headers: { Authorization: `Bearer ${OPENAI_ADMIN_KEY}` },
    });
    const d = await res.json();
    let total30d = 0, total7d = 0, todayCost = 0;
    const dailyBreakdown: any[] = [];
    for (const b of d.data || []) {
      let dayTotal = 0;
      for (const r of b.results || []) dayTotal += parseFloat(r.amount?.value || 0);
      total30d += dayTotal;
      if (b.start_time >= end - 7 * 86400) total7d += dayTotal;
      if (b.start_time >= end - 86400) todayCost += dayTotal;
      if (b.start_time >= end - 7 * 86400 && dayTotal > 0) {
        dailyBreakdown.push({ label: new Date(b.start_time * 1000).toLocaleDateString(), value: `$${dayTotal.toFixed(2)}`, type: "cost" });
      }
    }
    return {
      name: "OpenAI", status: "ok", monthlyCost: total30d,
      metrics: [
        { label: "Today", value: `$${todayCost.toFixed(2)}`, type: "cost" },
        { label: "Last 7 days", value: `$${total7d.toFixed(2)}`, type: "cost" },
        { label: "Last 30 days", value: `$${total30d.toFixed(2)}`, type: "cost" },
        ...dailyBreakdown,
      ],
      link: "https://platform.openai.com/usage",
    };
  } catch { return errorCard("OpenAI", 0, "Admin key needed or timed out", "https://platform.openai.com/usage"); }
}

async function getClaude(): Promise<ProviderData> {
  if (!ANTHROPIC_ADMIN_KEY) {
    return {
      name: "Claude (Anthropic)", status: "gray", monthlyCost: 0,
      metrics: [{ label: "Status", value: "Admin key not set" }],
      link: "https://console.anthropic.com/settings/billing",
    };
  }
  try {
    const now = new Date();
    const start30d = new Date(now.getTime() - 30 * 86400_000).toISOString().split("T")[0] + "T00:00:00Z";
    const start7d = new Date(now.getTime() - 7 * 86400_000).toISOString().split("T")[0] + "T00:00:00Z";
    const end = now.toISOString().split("T")[0] + "T23:59:59Z";

    const res = await fetchT(
      `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start30d}&ending_at=${end}`,
      { headers: { "x-api-key": ANTHROPIC_ADMIN_KEY, "anthropic-version": "2023-06-01" } },
    );
    const d = await res.json();

    let total30d = 0, total7d = 0, todayCost = 0;
    const todayStr = now.toISOString().split("T")[0];
    const dailyBreakdown: { label: string; value: string; type: string }[] = [];

    for (const bucket of d.data || []) {
      let dayCents = 0;
      for (const r of bucket.results || []) dayCents += parseFloat(r.amount || "0");
      const dayDollars = dayCents / 100;
      total30d += dayDollars;
      const bucketDate = (bucket.starting_at || "").split("T")[0];
      if (bucketDate >= start7d.split("T")[0]) total7d += dayDollars;
      if (bucketDate === todayStr) todayCost += dayDollars;
      if (bucketDate >= start7d.split("T")[0] && dayDollars > 0.01) {
        dailyBreakdown.push({ label: bucketDate, value: `$${dayDollars.toFixed(2)}`, type: "cost" });
      }
    }

    return {
      name: "Claude (Anthropic)", status: total30d > 100 ? "warn" : "ok", monthlyCost: total30d,
      metrics: [
        { label: "Today", value: `$${todayCost.toFixed(2)}`, type: "cost" },
        { label: "Last 7 days", value: `$${total7d.toFixed(2)}`, type: "cost" },
        { label: "Last 30 days", value: `$${total30d.toFixed(2)}`, type: "cost" },
        ...dailyBreakdown,
      ],
      link: "https://console.anthropic.com/settings/billing",
    };
  } catch { return errorCard("Claude (Anthropic)", 0, "Admin API failed", "https://console.anthropic.com/settings/billing"); }
}

async function getElevenLabs(): Promise<ProviderData> {
  try {
    const res = await fetchT("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": ELEVENLABS_KEY },
    });
    const d = await res.json();
    const used = d.character_count || 0;
    const limit = d.character_limit || 1;
    const pct = (used / limit) * 100;
    return {
      name: "ElevenLabs", status: pct > 80 ? "warn" : "ok", monthlyCost: 0,
      metrics: [
        { label: "Plan", value: d.tier },
        { label: "Credits used", value: `${used.toLocaleString()} / ${limit.toLocaleString()}` },
        { label: "Usage", value: `${pct.toFixed(1)}%` },
        { label: "Resets", value: d.next_character_count_reset_unix ? new Date(d.next_character_count_reset_unix * 1000).toLocaleDateString() : "?" },
      ],
      bar: { pct },
      link: "https://elevenlabs.io/app/settings/billing",
    };
  } catch { return errorCard("ElevenLabs"); }
}

async function getRapidApiSearch(): Promise<ProviderData> {
  try {
    const res = await fetchT("https://youtube-media-downloader.p.rapidapi.com/v2/search/videos?keyword=test", {
      headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": "youtube-media-downloader.p.rapidapi.com" },
    });
    const limit = parseInt(res.headers.get("x-ratelimit-requests-limit") || "0");
    const remaining = parseInt(res.headers.get("x-ratelimit-requests-remaining") || "0");
    const used = limit - remaining;
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    return {
      name: "RapidAPI — DataFanatic (Search)", status: "ok", monthlyCost: 12,
      metrics: [
        { label: "Plan", value: "Pro ($12/mo)" },
        { label: "Today", value: `${used} / ${limit} requests` },
        { label: "Remaining", value: `${remaining}` },
      ],
      bar: { pct },
    };
  } catch { return errorCard("RapidAPI — DataFanatic", 12); }
}

async function getRapidApiDownload(): Promise<ProviderData> {
  try {
    const res = await fetchT("https://youtube-info-download-api.p.rapidapi.com/ajax/download.php?format=mp3&url=test", {
      headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": "youtube-info-download-api.p.rapidapi.com" },
    });
    const limit = parseInt(res.headers.get("x-ratelimit-requests-limit") || "0");
    const remaining = parseInt(res.headers.get("x-ratelimit-requests-remaining") || "0");
    const unitsLimit = parseInt(res.headers.get("x-ratelimit-units-limit") || "0");
    const unitsRemaining = parseInt(res.headers.get("x-ratelimit-units-remaining") || "0");
    const used = limit - remaining;
    const unitsUsed = unitsLimit - unitsRemaining;
    return {
      name: "RapidAPI — YouTube Download", status: "ok", monthlyCost: 0,
      metrics: [
        { label: "Requests", value: `${used.toLocaleString()} / ${limit.toLocaleString()}` },
        { label: "Units", value: `${unitsUsed.toLocaleString()} / ${unitsLimit.toLocaleString()}` },
      ],
      bar: { pct: unitsLimit > 0 ? (unitsUsed / unitsLimit) * 100 : 0 },
    };
  } catch { return errorCard("RapidAPI — YouTube Download"); }
}

async function getBunny(): Promise<ProviderData> {
  try {
    const [billRes, statsRes, libsRes] = await Promise.all([
      fetchT("https://api.bunny.net/billing", { headers: { AccessKey: BUNNY_KEY } }),
      fetchT("https://api.bunny.net/statistics", { headers: { AccessKey: BUNNY_KEY } }),
      fetchT("https://api.bunny.net/videolibrary", { headers: { AccessKey: BUNNY_KEY, Accept: "application/json" } }),
    ]);
    const bill = await billRes.json();
    const stats = await statsRes.json().catch(() => ({}));
    const libs = await libsRes.json().catch(() => []);

    const charges = bill.ThisMonthCharges || 0;
    const balance = bill.Balance || 0;
    const commit = bill.MinimumMonthlyCommit || 0;

    const trafficByRegion = [
      ["EU", bill.MonthlyChargesEUTraffic],
      ["US", bill.MonthlyChargesUSTraffic],
      ["Asia", bill.MonthlyChargesASIATraffic],
      ["Africa", bill.MonthlyChargesAFTraffic],
      ["S.America", bill.MonthlyChargesSATraffic],
    ].filter(([, v]) => (v as number) > 0);

    const serviceLines: [string, number][] = [
      ["Storage", bill.MonthlyChargesStorage],
      ["Transcribe", bill.MonthlyChargesTranscribe],
      ["Premium Encoding", bill.MonthlyChargesPremiumEncoding],
      ["DRM", bill.MonthlyChargesDrm],
      ["Optimizer", bill.MonthlyChargesOptimizer],
      ["DNS", bill.MonthlyChargesDNS],
    ].filter(([, v]) => v > 0) as [string, number][];

    const bwGB = (stats.TotalBandwidthUsed || bill.MonthlyBandwidthUsed || 0) / 1e9;
    const totalStorageBytes = (libs || []).reduce((s: number, l: any) => s + (l.StorageUsage || 0), 0);
    const totalTrafficBytes = (libs || []).reduce((s: number, l: any) => s + (l.TrafficUsage || 0), 0);
    const videoCount = (libs || []).reduce((s: number, l: any) => s + (l.VideoCount || 0), 0);

    const metrics: { label: string; value: string; type?: string }[] = [
      { label: "Balance", value: `$${balance.toFixed(2)}`, type: balance < commit ? "cost" : "ok" },
      { label: "This month", value: `$${charges.toFixed(2)}`, type: charges > 0 ? "cost" : "ok" },
      { label: "Min monthly commit", value: `$${commit.toFixed(2)}` },
      { label: "Bandwidth (30d)", value: `${bwGB.toFixed(2)} GB` },
    ];

    if (libs?.length) {
      metrics.push(
        { label: "Stream libraries", value: `${libs.length}` },
        { label: "Videos", value: `${videoCount}` },
        { label: "Stream storage", value: `${(totalStorageBytes / 1e9).toFixed(1)} GB` },
        { label: "Stream traffic (cycle)", value: `${(totalTrafficBytes / 1e9).toFixed(2)} GB` },
      );
    }

    for (const [r, v] of trafficByRegion) metrics.push({ label: `Traffic — ${r}`, value: `$${(v as number).toFixed(2)}`, type: "cost" });
    for (const [k, v] of serviceLines) metrics.push({ label: k, value: `$${v.toFixed(2)}`, type: "cost" });

    const transMin = bill.MonthlyTranscriptionMinutes || 0;
    if (transMin > 0) metrics.push({ label: "Transcription (min)", value: `${transMin}` });
    const encMin = bill.MonthlyPremiumEncodingBillableMinutes || 0;
    if (encMin > 0) metrics.push({ label: "Premium encoding (min)", value: `${encMin}` });

    const status = balance < commit ? "warn" : charges > 0 ? "ok" : "ok";

    return {
      name: "Bunny.net", status, monthlyCost: charges,
      metrics,
      link: "https://dash.bunny.net/account/billing",
    };
  } catch { return errorCard("Bunny.net"); }
}

const SNIPPETS_AUTO_TABLE_EXP = "youtubetranscripts-429803.reptranscripts.snippets_auto";

async function getClipProviderUsage(provider: "vizard" | "opusclip"): Promise<ProviderData> {
  const prettyName = provider === "vizard" ? "Vizard" : "Opus Clip";
  const link = provider === "vizard"
    ? "https://vizard.ai/dashboard"
    : "https://www.opus.pro/dashboard";
  try {
    const { bigQuery } = await import("@/lib/bigquery");
    const [totalsRes, monthRes, trendRes] = await Promise.all([
      withTimeout(bigQuery.query({
        query: `SELECT COUNT(*) AS clips,
                       COUNT(DISTINCT original_video_id) AS videos,
                       ROUND(SUM(duration_ms)/1000/60, 1) AS minutes
                FROM \`${SNIPPETS_AUTO_TABLE_EXP}\` WHERE provider = @p`,
        params: { p: provider },
      }), PROVIDER_TIMEOUT_MS, `${provider}-totals`),
      withTimeout(bigQuery.query({
        query: `SELECT COUNT(*) AS clips,
                       COUNT(DISTINCT original_video_id) AS videos,
                       ROUND(SUM(duration_ms)/1000/60, 1) AS minutes
                FROM \`${SNIPPETS_AUTO_TABLE_EXP}\`
                WHERE provider = @p
                  AND DATE(created_at) >= DATE_TRUNC(CURRENT_DATE(), MONTH)`,
        params: { p: provider },
      }), PROVIDER_TIMEOUT_MS, `${provider}-mtd`),
      withTimeout(bigQuery.query({
        query: `SELECT FORMAT_DATE('%Y-%m', DATE(created_at)) AS month,
                       COUNT(*) AS clips
                FROM \`${SNIPPETS_AUTO_TABLE_EXP}\`
                WHERE provider = @p AND created_at IS NOT NULL
                GROUP BY month ORDER BY month DESC LIMIT 3`,
        params: { p: provider },
      }), PROVIDER_TIMEOUT_MS, `${provider}-trend`),
    ]);
    const t: any = ((totalsRes as any)[0] as any[])[0] || {};
    const m: any = ((monthRes as any)[0] as any[])[0] || {};
    const trend = ((trendRes as any)[0] as any[]) || [];

    const metrics: { label: string; value: string; type?: string }[] = [
      { label: "Source", value: "No billing API — from BQ" },
      { label: "This month (clips)", value: `${Number(m.clips || 0)}` },
      { label: "This month (videos)", value: `${Number(m.videos || 0)}` },
    ];
    if (m.minutes) metrics.push({ label: "This month (minutes)", value: `${Number(m.minutes).toFixed(1)}` });

    metrics.push(
      { label: "All-time clips", value: `${Number(t.clips || 0)}` },
      { label: "All-time videos", value: `${Number(t.videos || 0)}` },
    );
    if (t.minutes) metrics.push({ label: "All-time minutes", value: `${Number(t.minutes).toFixed(1)}` });

    for (const r of trend) {
      metrics.push({ label: `· ${r.month}`, value: `${Number(r.clips)} clips` });
    }

    return { name: prettyName, status: "ok", monthlyCost: 0, metrics, link };
  } catch (e) {
    return {
      name: prettyName, status: "error", monthlyCost: 0,
      metrics: [{ label: "Error", value: String((e as any)?.message || "BQ failed") }],
      link,
    };
  }
}

async function getVizard()   { return getClipProviderUsage("vizard"); }
async function getOpusClip() { return getClipProviderUsage("opusclip"); }

const BILLING_TABLE = "youtubetranscripts-429803.billing_export.gcp_billing_export_v1_0187F0_B79ECE_F87324";

async function getGCP(): Promise<ProviderData> {
  try {
    const { bigQuery } = await import("@/lib/bigquery");

    const [mtdRows, prevMonthRows, todayRows, last7Rows, storageRows] = await Promise.all([
      withTimeout(bigQuery.query({
        query: `SELECT service.description AS service, ROUND(SUM(cost), 2) AS cost
                FROM \`${BILLING_TABLE}\`
                WHERE invoice.month = FORMAT_DATE('%Y%m', CURRENT_DATE())
                GROUP BY service HAVING cost > 0.01 ORDER BY cost DESC`,
      }), PROVIDER_TIMEOUT_MS, "bq-mtd"),
      withTimeout(bigQuery.query({
        query: `SELECT ROUND(SUM(cost), 2) AS cost
                FROM \`${BILLING_TABLE}\`
                WHERE invoice.month = FORMAT_DATE('%Y%m', DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH))`,
      }), PROVIDER_TIMEOUT_MS, "bq-prev"),
      withTimeout(bigQuery.query({
        query: `SELECT ROUND(SUM(cost), 2) AS cost
                FROM \`${BILLING_TABLE}\`
                WHERE DATE(usage_start_time) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)`,
      }), PROVIDER_TIMEOUT_MS, "bq-today"),
      withTimeout(bigQuery.query({
        query: `SELECT ROUND(SUM(cost), 2) AS cost
                FROM \`${BILLING_TABLE}\`
                WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)`,
      }), PROVIDER_TIMEOUT_MS, "bq-7d"),
      withTimeout(bigQuery.query({
        query: `SELECT SUM(size_bytes) AS total_bytes FROM \`youtubetranscripts-429803\`.reptranscripts.__TABLES__`,
      }), PROVIDER_TIMEOUT_MS, "bq-storage"),
    ]);

    const mtd = (mtdRows as any)[0] as any[];
    const mtdTotal = mtd.reduce((s, r) => s + Number(r.cost || 0), 0);
    const prevTotal = Number(((prevMonthRows as any)[0] as any[])[0]?.cost || 0);
    const yestTotal = Number(((todayRows as any)[0] as any[])[0]?.cost || 0);
    const last7Total = Number(((last7Rows as any)[0] as any[])[0]?.cost || 0);
    const bqStorageGB = Number(((storageRows as any)[0] as any[])[0]?.total_bytes || 0) / 1e9;

    const now = new Date();
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const projected = (mtdTotal / dayOfMonth) * daysInMonth;
    const invoiceMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    const metrics: { label: string; value: string; type?: string }[] = [
      { label: `Invoice ${invoiceMonth} (day ${dayOfMonth}/${daysInMonth})`, value: `$${mtdTotal.toFixed(2)}`, type: "cost" },
      { label: "Projected month-end", value: `$${projected.toFixed(2)}`, type: "cost" },
      { label: "Yesterday", value: `$${yestTotal.toFixed(2)}`, type: "cost" },
      { label: "Last 7 days", value: `$${last7Total.toFixed(2)}`, type: "cost" },
      { label: "Last month total", value: `$${prevTotal.toFixed(2)}`, type: "cost" },
    ];

    for (const r of mtd) {
      metrics.push({ label: `· ${r.service}`, value: `$${Number(r.cost).toFixed(2)}`, type: "cost" });
    }

    metrics.push({ label: "BQ Storage (reptranscripts)", value: `${bqStorageGB.toFixed(1)} GB` });

    return {
      name: "GCP", status: projected > 500 ? "warn" : "ok", monthlyCost: mtdTotal,
      metrics,
      link: "https://console.cloud.google.com/billing/0187F0-B79ECE-F87324/reports",
    };
  } catch (e) {
    return {
      name: "GCP", status: "error", monthlyCost: 0,
      metrics: [
        { label: "Error", value: String((e as any)?.message || "BQ billing_export query failed") },
      ],
      link: "https://console.cloud.google.com/billing/0187F0-B79ECE-F87324/reports",
    };
  }
}

async function getAWS(): Promise<ProviderData> {
  try {
    const { CostExplorerClient, GetCostAndUsageCommand } = await import("@aws-sdk/client-cost-explorer");
    const ce = new CostExplorerClient({ region: "us-east-1" });
    const now = new Date();
    const end = now.toISOString().split("T")[0];
    const start30d = new Date(now.getTime() - 30 * 86400_000).toISOString().split("T")[0];
    const start7d = new Date(now.getTime() - 7 * 86400_000).toISOString().split("T")[0];

    const [monthly, weekly] = await Promise.all([
      ce.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: start30d, End: end },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      })),
      ce.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: start7d, End: end },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
      })),
    ]);

    let total30d = 0;
    const services: { name: string; cost: number }[] = [];
    for (const period of monthly.ResultsByTime || []) {
      for (const g of period.Groups || []) {
        const cost = parseFloat(g.Metrics?.UnblendedCost?.Amount || "0");
        if (cost > 0.001) {
          services.push({ name: g.Keys?.[0] || "Unknown", cost });
          total30d += cost;
        }
      }
    }
    services.sort((a, b) => b.cost - a.cost);

    let total7d = 0;
    for (const period of weekly.ResultsByTime || []) {
      total7d += parseFloat(period.Total?.UnblendedCost?.Amount || "0");
    }

    const metrics: { label: string; value: string; type?: string }[] = [
      { label: "Last 7 days", value: `$${total7d.toFixed(2)}`, type: "cost" },
      { label: "Last 30 days", value: `$${total30d.toFixed(2)}`, type: "cost" },
    ];
    for (const s of services.slice(0, 8)) {
      metrics.push({ label: s.name.replace("Amazon ", "").replace("AWS ", ""), value: `$${s.cost.toFixed(4)}`, type: "cost" });
    }

    return {
      name: "AWS", status: total30d > 50 ? "warn" : "ok", monthlyCost: total30d,
      metrics,
      link: "https://us-east-1.console.aws.amazon.com/costmanagement/home#/dashboard",
    };
  } catch (e) {
    return errorCard("AWS", 0, String((e as Error)?.message || "Cost Explorer failed"), "https://us-east-1.console.aws.amazon.com/costmanagement/home#/dashboard");
  }
}

export async function GET() {
  const tasks: { fn: () => Promise<ProviderData>; name: string }[] = [
    { fn: getApify, name: "Apify" },
    { fn: getOpenAI, name: "OpenAI" },
    { fn: getClaude, name: "Claude (Anthropic)" },
    { fn: getElevenLabs, name: "ElevenLabs" },
    { fn: getRapidApiSearch, name: "RapidAPI — DataFanatic (Search)" },
    { fn: getRapidApiDownload, name: "RapidAPI — YouTube Download" },
    { fn: getBunny, name: "Bunny.net" },
    { fn: getVizard, name: "Vizard" },
    { fn: getOpusClip, name: "Opus Clip" },
    { fn: getGCP, name: "GCP" },
    { fn: getAWS, name: "AWS" },
  ];

  const providers = await Promise.all(
    tasks.map(({ fn, name }) =>
      withTimeout(fn(), PROVIDER_TIMEOUT_MS, name).catch(() => errorCard(name, 0, "Timed out"))
    )
  );

  return NextResponse.json({ providers, timestamp: new Date().toISOString() });
}
