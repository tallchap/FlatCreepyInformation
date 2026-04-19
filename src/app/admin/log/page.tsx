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

interface Row {
  video_id: string;
  requested_at: string;
  speaker: string | null;
  video_title: string | null;
  channel_name: string | null;
  channel_id: string | null;
  published_date: string | null;
  duration_seconds: number | null;
  youtube_link: string;
}

interface ApiResp {
  rows: Row[];
  events: Record<string, Ev[]>;
  page: number;
  pageSize: number;
  hasMore: boolean;
  total: number;
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

function rowBadge(events: Ev[]): { label: string; color: string } | null {
  if (!events.length) return null;
  const latest = events[0];
  const hasError = events.some((e) => e.status === "error");
  if (latest.status === "error") return { label: "error", color: "#dc2626" };
  if (latest.status === "success" && latest.step === "bunny-ready") return { label: "complete", color: "#16a34a" };
  if (latest.status === "success" && latest.step === "bunny-fetch-queued") return { label: "in-flight", color: "#ca8a04" };
  if (latest.status === "success") return { label: "success", color: "#16a34a" };
  if (hasError) return { label: "retried", color: "#ca8a04" };
  return { label: "in-flight", color: "#ca8a04" };
}

const PAGE_SIZE = 20;
const DASH = <span style={{ color: "#9ca3af" }}>—</span>;

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
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ key, page: String(page), pageSize: String(PAGE_SIZE) });
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
  }, [key, filterVideoId, page]);

  useEffect(() => { load(); }, [load]);

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const rows = data?.rows ?? [];
  const events = data?.events ?? {};

  useEffect(() => {
    if (filterVideoId && rows.length === 1) {
      setExpanded(new Set([0]));
    }
  }, [filterVideoId, rows.length]);

  if (!key) {
    return (
      <main style={{ padding: 40, fontFamily: "system-ui" }}>
        <h1>Admin Log</h1>
        <p>Missing <code>?key=</code> in URL.</p>
      </main>
    );
  }

  const toggle = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
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
            <th style={th}>Title</th>
            <th style={th}>Latest Step</th>
            <th style={th}>Status</th>
            <th style={th}>Events</th>
            <th style={th}>Duration</th>
            <th style={th}>Last Event</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.flatMap((r, idx) => {
            const isOpen = expanded.has(idx);
            const evs = events[r.video_id] || [];
            const badge = rowBadge(evs);
            const latest = evs[0];
            const first = evs[evs.length - 1];
            const dur = latest && first ? latest.ts - first.ts : null;

            const out: ReactElement[] = [
              <tr key={`row-${idx}`}
                  style={{ borderTop: "1px solid #e5e7eb", cursor: "pointer" }}
                  onClick={() => toggle(idx)}>
                <td style={td}>{isOpen ? "▼" : "▶"}</td>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{r.video_id}</td>
                <td style={{ ...td, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={r.video_title || ""}>
                  {r.video_title || DASH}
                </td>
                <td style={td}>{latest ? <code>{latest.step}</code> : DASH}</td>
                <td style={{ ...td, ...(badge ? { color: badge.color, fontWeight: 600 } : {}) }}>
                  {badge ? badge.label : DASH}
                </td>
                <td style={td}>{evs.length || DASH}</td>
                <td style={td}>{dur !== null ? elapsed(dur) : DASH}</td>
                <td style={td}>{latest ? fmt(latest.ts) : DASH}</td>
              </tr>,
            ];

            if (isOpen) {
              out.push(
                <tr key={`exp-${idx}`} style={{ background: "#fafafa" }}>
                  <td colSpan={8} style={{ padding: 0 }}>
                    <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", gap: 24, fontSize: 13, flexWrap: "wrap" }}>
                      <span><b>Channel:</b> {r.channel_name || DASH}</span>
                      <span><b>Uploaded:</b> {r.published_date || DASH}</span>
                      <span><b>Requested:</b> {fmt(new Date(r.requested_at).getTime())}</span>
                      {r.speaker && <span><b>Speaker:</b> {r.speaker}</span>}
                      <a href={`/edit?v=${r.video_id}`}
                         target="_blank"
                         rel="noopener noreferrer"
                         onClick={(e) => e.stopPropagation()}
                         style={{ color: "#2563eb", textDecoration: "none", marginLeft: "auto" }}>
                        Snippy ↗
                      </a>
                      <a href={r.youtube_link}
                         target="_blank"
                         rel="noopener noreferrer"
                         onClick={(e) => e.stopPropagation()}
                         style={{ color: "#2563eb", textDecoration: "none" }}>
                        YouTube ↗
                      </a>
                    </div>
                    {evs.length ? (
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
                          {evs.map((e, i) => (
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
                    ) : (
                      <div style={{ padding: "12px 16px", color: "#6b7280", fontSize: 12 }}>
                        No pipeline events recorded for this video.
                      </div>
                    )}
                  </td>
                </tr>,
              );
            }
            return out;
          }) : (
            <tr><td style={{ ...td, textAlign: "center", color: "#6b7280" }} colSpan={8}>
              {loading ? "Loading…" : "No transcribe requests yet"}
            </td></tr>
          )}
        </tbody>
      </table>

      {!filterVideoId && (
        <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} style={btn}>Prev</button>
          <span style={{ fontSize: 13, color: "#6b7280" }}>
            Page {page} of {pageCount} · {rows.length} row{rows.length === 1 ? "" : "s"} shown of {data?.total ?? 0}
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
