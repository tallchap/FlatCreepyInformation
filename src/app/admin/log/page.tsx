"use client";

import { ReactElement, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

interface Ev {
  ts: number;
  videoId: string;
  pipeline: string;
  step: string;
  status: "info" | "success" | "error";
  detail?: any;
}

interface ApiResp {
  events: Ev[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  total: number;
}

interface Rollup {
  videoId: string;
  latest: Ev;
  first: Ev;
  count: number;
  hasError: boolean;
  events: Ev[];
}

function fmt(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function elapsed(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function statusColor(s: string) {
  if (s === "error") return "#dc2626";
  if (s === "success") return "#16a34a";
  return "#6b7280";
}

function rollupBadge(r: Rollup): { label: string; color: string } {
  if (r.hasError) return { label: "error", color: "#dc2626" };
  if (r.latest.status === "success" && r.latest.step === "bunny-fetch-queued") return { label: "complete", color: "#16a34a" };
  if (r.latest.status === "success") return { label: "success", color: "#16a34a" };
  return { label: "in-flight", color: "#ca8a04" };
}

const VIDEOS_PER_PAGE = 20;

export default function AdminLogPage() {
  return (
    <Suspense fallback={<main style={{ padding: 40, fontFamily: "system-ui" }}>Loading…</main>}>
      <AdminLog />
    </Suspense>
  );
}

function AdminLog() {
  const params = useSearchParams();
  const key = params.get("key") || "";

  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterVideoId, setFilterVideoId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ key, page: "1", pageSize: "500" });
      if (filterVideoId) qs.set("videoId", filterVideoId);
      const res = await fetch(`/api/admin/log?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e: any) {
      setError(e.message || "Load failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [key, filterVideoId]);

  useEffect(() => { load(); }, [load]);

  const rollups = useMemo<Rollup[]>(() => {
    if (!data?.events?.length) return [];
    const groups = new Map<string, Ev[]>();
    for (const e of data.events) {
      if (!groups.has(e.videoId)) groups.set(e.videoId, []);
      groups.get(e.videoId)!.push(e);
    }
    return [...groups.entries()]
      .map(([videoId, evs]) => ({
        videoId,
        latest: evs[0],
        first: evs[evs.length - 1],
        count: evs.length,
        hasError: evs.some((e) => e.status === "error"),
        events: evs,
      }))
      .sort((a, b) => b.latest.ts - a.latest.ts);
  }, [data]);

  const pageCount = Math.max(1, Math.ceil(rollups.length / VIDEOS_PER_PAGE));
  const visible = filterVideoId
    ? rollups
    : rollups.slice((page - 1) * VIDEOS_PER_PAGE, page * VIDEOS_PER_PAGE);

  useEffect(() => {
    // auto-expand single row in filter mode
    if (filterVideoId && rollups.length === 1) {
      setExpanded(new Set([rollups[0].videoId]));
    }
  }, [filterVideoId, rollups]);

  if (!key) {
    return (
      <main style={{ padding: 40, fontFamily: "system-ui" }}>
        <h1>Admin Log</h1>
        <p>Missing <code>?key=</code> in URL.</p>
      </main>
    );
  }

  const toggle = (vid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(vid)) next.delete(vid); else next.add(vid);
      return next;
    });
  };

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Pipeline Log</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {filterVideoId && (
            <>
              <span style={{ fontSize: 13, color: "#6b7280" }}>
                Filtered: <code>{filterVideoId}</code>
              </span>
              <button onClick={() => { setFilterVideoId(null); setPage(1); }} style={btn}>Clear filter</button>
            </>
          )}
          <button onClick={() => load()} disabled={loading} style={btn}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div style={{ color: "#dc2626", marginBottom: 12 }}>Error: {error}</div>}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#f9fafb", textAlign: "left" }}>
            <th style={{ ...th, width: 30 }}></th>
            <th style={th}>Video</th>
            <th style={th}>Latest Step</th>
            <th style={th}>Status</th>
            <th style={th}>Events</th>
            <th style={th}>Duration</th>
            <th style={th}>Last Event</th>
          </tr>
        </thead>
        <tbody>
          {visible.length ? visible.flatMap((r) => {
            const isOpen = expanded.has(r.videoId);
            const badge = rollupBadge(r);
            const dur = r.latest.ts - r.first.ts;
            const rows: ReactElement[] = [
              <tr key={`row-${r.videoId}`}
                  style={{ borderTop: "1px solid #e5e7eb", cursor: "pointer" }}
                  onClick={() => toggle(r.videoId)}>
                <td style={td}>{isOpen ? "▼" : "▶"}</td>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{r.videoId}</td>
                <td style={td}><code>{r.latest.step}</code></td>
                <td style={{ ...td, color: badge.color, fontWeight: 600 }}>{badge.label}</td>
                <td style={td}>{r.count}</td>
                <td style={td}>{elapsed(dur)}</td>
                <td style={td}>{fmt(r.latest.ts)}</td>
              </tr>,
            ];
            if (isOpen) {
              rows.push(
                <tr key={`exp-${r.videoId}`} style={{ background: "#fafafa" }}>
                  <td colSpan={7} style={{ padding: 0 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                          <th style={subTh}>Time</th>
                          <th style={subTh}>Pipeline</th>
                          <th style={subTh}>Step</th>
                          <th style={subTh}>Status</th>
                          <th style={subTh}>Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.events.map((e, i) => (
                          <tr key={i} style={{ borderTop: "1px solid #e5e7eb" }}>
                            <td style={subTd}>{fmt(e.ts)}</td>
                            <td style={subTd}>{e.pipeline}</td>
                            <td style={subTd}><code>{e.step}</code></td>
                            <td style={{ ...subTd, color: statusColor(e.status), fontWeight: 500 }}>{e.status}</td>
                            <td style={subTd}>
                              {e.detail ? <code style={{ fontSize: 11 }}>{typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}</code> : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>,
              );
            }
            return rows;
          }) : (
            <tr><td style={{ ...td, textAlign: "center", color: "#6b7280" }} colSpan={7}>
              {loading ? "Loading…" : "No events"}
            </td></tr>
          )}
        </tbody>
      </table>

      {!filterVideoId && (
        <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} style={btn}>Prev</button>
          <span style={{ fontSize: 13, color: "#6b7280" }}>
            Page {page} of {pageCount} · {visible.length} video{visible.length === 1 ? "" : "s"} shown of {rollups.length}
          </span>
          <button onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount || loading} style={btn}>Next</button>
        </div>
      )}
    </main>
  );
}

const btn: React.CSSProperties = {
  padding: "6px 12px", background: "white", border: "1px solid #d1d5db", borderRadius: 6,
  fontSize: 13, cursor: "pointer",
};
const th: React.CSSProperties = { padding: "8px 12px", fontWeight: 600, fontSize: 12, textTransform: "uppercase", color: "#6b7280" };
const td: React.CSSProperties = { padding: "8px 12px", verticalAlign: "top" };
const subTh: React.CSSProperties = { padding: "6px 16px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", color: "#6b7280" };
const subTd: React.CSSProperties = { padding: "6px 16px", verticalAlign: "top" };
