import Redis from "ioredis";

// Shared Redis client (lazy-initialized). REDIS_URL must be set in env.
let _redis: Redis | null = null;
function client(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  _redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  _redis.on("error", (e) => console.error("[pipeline-log] redis error:", e.message));
  return _redis;
}

export type Pipeline = "transcribe" | "research" | "clip-gcs";

export interface PipelineEvent {
  ts: number;
  videoId: string;
  pipeline: Pipeline;
  step: string;
  status: "info" | "success" | "error";
  detail?: any;
}

// Fire-and-forget: never throws. Logging should never break the caller.
export async function logEvent(e: Omit<PipelineEvent, "ts">): Promise<void> {
  const r = client();
  if (!r) return;
  try {
    const payload: PipelineEvent = { ts: Date.now(), ...e };
    const json = JSON.stringify(payload);
    const videoKey = `pipeline:video:${e.videoId}`;
    await Promise.all([
      r.lpush("pipeline:events", json),
      r.ltrim("pipeline:events", 0, 9999),
      r.lpush(videoKey, json),
      r.ltrim(videoKey, 0, 99),
      r.expire(videoKey, 60 * 60 * 24 * 30),
      r.hset(`pipeline:latest:${e.videoId}`, {
        step: e.step,
        status: e.status,
        pipeline: e.pipeline,
        ts: String(Date.now()),
      }),
      r.expire(`pipeline:latest:${e.videoId}`, 60 * 60 * 24 * 30),
    ]);
  } catch (err: any) {
    console.error("[pipeline-log] logEvent failed:", err?.message || err);
  }
}

export async function readEvents(opts: {
  page?: number;
  pageSize?: number;
  videoId?: string | null;
}): Promise<{ events: PipelineEvent[]; page: number; pageSize: number; hasMore: boolean; total: number }> {
  const r = client();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  if (!r) return { events: [], page, pageSize, hasMore: false, total: 0 };

  const key = opts.videoId ? `pipeline:video:${opts.videoId}` : "pipeline:events";
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;
  const [raw, total] = await Promise.all([r.lrange(key, start, end), r.llen(key)]);
  const events = raw
    .map((s) => {
      try { return JSON.parse(s) as PipelineEvent; } catch { return null; }
    })
    .filter(Boolean) as PipelineEvent[];
  return { events, page, pageSize, hasMore: start + events.length < total, total };
}

/* ── Clip events (admin /log Clips tab — in-flight source) ────────────
 * Written by services/download/server.js logClipEvent(). Key structure:
 *   pipeline:clip:<jobId>          → list of event JSON blobs (lpush, 24h TTL)
 *   pipeline:clip-latest:<jobId>   → hash with {step, status, pipeline, videoId, ts}
 *   pipeline:clip-active           → set of jobIds currently in-flight
 */

export interface ClipEvent {
  ts: number;
  jobId: string;
  videoId: string;
  pipeline: string;
  step: string;
  status: "info" | "success" | "error";
  detail?: any;
}

export interface ActiveClip {
  jobId: string;
  videoId: string;
  pipeline: string;
  step: string;
  status: string;
  ts: number;              // last update ms epoch
  firstTs: number;         // first event ms epoch
  events: ClipEvent[];
}

export async function readActiveClips(): Promise<ActiveClip[]> {
  const r = client();
  if (!r) return [];
  const jobIds = await r.smembers("pipeline:clip-active");
  if (!jobIds.length) return [];
  const rows = await Promise.all(jobIds.map(async (jobId) => {
    const [latest, rawEvents] = await Promise.all([
      r.hgetall(`pipeline:clip-latest:${jobId}`),
      r.lrange(`pipeline:clip:${jobId}`, 0, -1),
    ]);
    const events: ClipEvent[] = rawEvents
      .map((s) => { try { return JSON.parse(s) as ClipEvent; } catch { return null; } })
      .filter(Boolean) as ClipEvent[];
    const sorted = events.slice().sort((a, b) => a.ts - b.ts);
    return {
      jobId,
      videoId: latest?.videoId || sorted[0]?.videoId || "",
      pipeline: latest?.pipeline || sorted[0]?.pipeline || "",
      step: latest?.step || sorted[sorted.length - 1]?.step || "",
      status: latest?.status || "",
      ts: Number(latest?.ts || sorted[sorted.length - 1]?.ts || Date.now()),
      firstTs: sorted[0]?.ts || 0,
      events: sorted,
    };
  }));
  return rows;
}

export async function readClipEvents(jobId: string): Promise<ClipEvent[]> {
  const r = client();
  if (!r) return [];
  const raw = await r.lrange(`pipeline:clip:${jobId}`, 0, -1);
  return (raw
    .map((s) => { try { return JSON.parse(s) as ClipEvent; } catch { return null; } })
    .filter(Boolean) as ClipEvent[])
    .sort((a, b) => a.ts - b.ts);
}
