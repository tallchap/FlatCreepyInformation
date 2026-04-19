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

// ─── Clips tab types + helpers ───────────────────────────────────────

interface ClipEv {
  ts: number;
  jobId: string;
  videoId: string;
  pipeline: string;
  step: string;
  status: "info" | "success" | "error";
  detail?: any;
}

interface ClipRow {
  job_id: string;
  video_id: string;
  video_url: string | null;
  start_sec: number;
  end_sec: number;
  clip_duration_sec: number;
  quality: string | null;
  status: string;               // complete | failed | rejected | in-flight
  error: string | null;
  total_sec: number | null;
  rapidapi_sec: number | null;
  download_sec: number | null;
  trim_sec: number | null;
  file_size_bytes: number | null;
  video_duration_sec: number | null;
  video_resolution: string | null;
  created_at: string;
  video_title: string | null;
  channel_name: string | null;
  speaker: string | null;
  published_date: string | null;
  youtube_link: string | null;
  live?: boolean;
  latest_step?: string;
}

interface ClipApiResp {
  rows: ClipRow[];
  events: Record<string, ClipEv[]>;
  page: number;
  pageSize: number;
  hasMore: boolean;
  total: number;
}

function fmtDur(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function fmtMB(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function clipStatusColor(status: string) {
  if (status === "complete") return "#16a34a";
  if (status === "failed") return "#dc2626";
  if (status === "rejected") return "#b45309";      // amber
  if (status === "in-flight") return "#ca8a04";     // yellow
  return "#6b7280";
}

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
  const initialTab = params.get("tab") === "clips" ? "clips" : "videos";

  const [tab, setTab] = useState<"videos" | "clips">(initialTab);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResp | null>(null);
  const [clipData, setClipData] = useState<ClipApiResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterVideoId, setFilterVideoId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [clipExpanded, setClipExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ key, page: String(page), pageSize: String(PAGE_SIZE) });
      if (filterVideoId) qs.set("videoId", filterVideoId);
      const endpoint = tab === "clips" ? "/api/admin/clip-log" : "/api/admin/log";
      const res = await fetch(`${endpoint}?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (tab === "clips") setClipData(json); else setData(json);
    } catch (e: any) {
      setError(e.message || "Load failed");
      if (tab === "clips") setClipData(null); else setData(null);
    } finally {
      setLoading(false);
    }
  }, [key, filterVideoId, page, tab]);

  useEffect(() => { load(); }, [load]);

  // Reset paging and expansion when switching tabs.
  useEffect(() => {
    setPage(1);
    setExpanded(new Set());
    setClipExpanded(new Set());
  }, [tab]);

  const activeTotal = (tab === "clips" ? clipData?.total : data?.total) ?? 0;
  const pageCount = Math.max(1, Math.ceil(activeTotal / PAGE_SIZE));
  const rows = data?.rows ?? [];
  const events = data?.events ?? {};
  const clipRows = clipData?.rows ?? [];
  const clipEvents = clipData?.events ?? {};

  useEffect(() => {
    if (tab === "videos" && filterVideoId && rows.length === 1) {
      setExpanded(new Set([0]));
    }
    if (tab === "clips" && filterVideoId && clipRows.length === 1) {
      setClipExpanded(new Set([0]));
    }
  }, [tab, filterVideoId, rows.length, clipRows.length]);

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

  const toggleClip = (idx: number) => {
    setClipExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const selectTab = (t: "videos" | "clips") => {
    if (t === tab) return;
    setTab(t);
    // Sync URL so refreshes / shares preserve the view.
    const u = new URL(window.location.href);
    if (t === "clips") u.searchParams.set("tab", "clips");
    else u.searchParams.delete("tab");
    window.history.replaceState({}, "", u.toString());
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

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #e5e7eb", marginBottom: 16 }}>
        <button onClick={() => selectTab("videos")} style={tabBtn(tab === "videos")}>Videos</button>
        <button onClick={() => selectTab("clips")} style={tabBtn(tab === "clips")}>Clips</button>
      </div>

      {error && <div style={{ color: "#dc2626", marginBottom: 12 }}>Error: {error}</div>}

      {tab === "clips" ? (
        <ClipsTable
          rows={clipRows}
          events={clipEvents}
          expanded={clipExpanded}
          toggle={toggleClip}
          loading={loading}
        />
      ) : (

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

      )}

      {!filterVideoId && (
        <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} style={btn}>Prev</button>
          <span style={{ fontSize: 13, color: "#6b7280" }}>
            Page {page} of {pageCount} · {(tab === "clips" ? clipRows.length : rows.length)} row{(tab === "clips" ? clipRows.length : rows.length) === 1 ? "" : "s"} shown of {activeTotal}
          </span>
          <button onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount || loading} style={btn}>Next</button>
        </div>
      )}
    </main>
  );
}

function ClipsTable({
  rows, events, expanded, toggle, loading,
}: {
  rows: ClipRow[];
  events: Record<string, ClipEv[]>;
  expanded: Set<number>;
  toggle: (idx: number) => void;
  loading: boolean;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr style={{ background: "#f9fafb", textAlign: "left" }}>
          <th style={{ ...th, width: 30 }}></th>
          <th style={th}>Video ID</th>
          <th style={th}>Source Title</th>
          <th style={th}>Start-End</th>
          <th style={th}>Duration</th>
          <th style={th}>Quality</th>
          <th style={th}>Status</th>
          <th style={th}>Size</th>
          <th style={th}>Created</th>
        </tr>
      </thead>
      <tbody>
        {rows.length ? rows.flatMap((r, idx) => {
          const isOpen = expanded.has(idx);
          const evs = events[r.job_id] || [];
          const start = Math.floor(r.start_sec);
          const end = Math.ceil(r.end_sec);
          const sizeTxt = fmtMB(r.file_size_bytes);
          const created = r.created_at ? fmt(new Date(r.created_at).getTime()) : "";
          const statusLabel = r.live && r.latest_step ? `in-flight · ${r.latest_step}` : r.status;

          const out: ReactElement[] = [
            <tr key={`clip-${idx}`}
                style={{ borderTop: "1px solid #e5e7eb", cursor: "pointer" }}
                onClick={() => toggle(idx)}>
              <td style={td}>{isOpen ? "▼" : "▶"}</td>
              <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{r.video_id || DASH}</td>
              <td style={{ ...td, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={r.video_title || ""}>
                {r.video_title || DASH}
              </td>
              <td style={td}>{start}-{end}</td>
              <td style={td}>{fmtDur(r.clip_duration_sec) || DASH}</td>
              <td style={td}>{r.quality || DASH}</td>
              <td style={{ ...td, color: clipStatusColor(r.status), fontWeight: 600 }}>
                {statusLabel}
              </td>
              <td style={td}>{sizeTxt || DASH}</td>
              <td style={td}>{created || DASH}</td>
            </tr>,
          ];

          if (isOpen) {
            const snippyHref = `/edit?v=${r.video_id}&start=${start}&end=${end}`;
            // Prefer the authoritative youtube_link from transcribe_log (via LEFT JOIN).
            // Fall back to the clip-exports video_url (source MP4), then to a constructed youtu.be URL.
            const ytHref = r.youtube_link || r.video_url || `https://youtu.be/${r.video_id}`;
            out.push(
              <tr key={`clip-exp-${idx}`} style={{ background: "#fafafa" }}>
                <td colSpan={9} style={{ padding: 0 }}>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", gap: 24, fontSize: 13, flexWrap: "wrap", alignItems: "baseline" }}>
                    <span><b>Channel:</b> {r.channel_name || DASH}</span>
                    <span><b>Uploaded:</b> {r.published_date || DASH}</span>
                    <span><b>Requested:</b> {created}</span>
                    {r.speaker && <span><b>Speaker:</b> {r.speaker}</span>}
                    {r.video_duration_sec != null && <span><b>Video dur:</b> {fmtDur(r.video_duration_sec)}</span>}
                    {r.video_resolution && <span><b>Res:</b> {r.video_resolution}</span>}
                    <a href={snippyHref}
                       target="_blank"
                       rel="noopener noreferrer"
                       onClick={(e) => e.stopPropagation()}
                       style={{ color: "#2563eb", textDecoration: "none", marginLeft: "auto" }}>
                      Snippy ↗
                    </a>
                    <a href={ytHref}
                       target="_blank"
                       rel="noopener noreferrer"
                       onClick={(e) => e.stopPropagation()}
                       style={{ color: "#2563eb", textDecoration: "none" }}>
                      YouTube ↗
                    </a>
                  </div>

                  {/* Timing aggregates when terminal */}
                  {!r.live && (r.total_sec != null || r.rapidapi_sec != null || r.download_sec != null || r.trim_sec != null) && (
                    <div style={{ padding: "8px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", gap: 24, fontSize: 12, color: "#374151" }}>
                      {r.rapidapi_sec != null && <span>RapidAPI: {r.rapidapi_sec.toFixed(1)}s</span>}
                      {r.download_sec != null && <span>Download: {r.download_sec.toFixed(1)}s</span>}
                      {r.trim_sec != null && <span>Trim: {r.trim_sec.toFixed(1)}s</span>}
                      {r.total_sec != null && <span><b>Total: {r.total_sec.toFixed(1)}s</b></span>}
                    </div>
                  )}

                  {/* Error block on failure/rejection */}
                  {r.error && (
                    <pre style={{
                      padding: "12px 16px", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
                      fontSize: 11, fontFamily: "ui-monospace, monospace",
                      background: "#fef2f2", color: "#991b1b", borderBottom: "1px solid #e5e7eb",
                    }}>
                      {r.error}
                    </pre>
                  )}

                  {/* Events table */}
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
                      No event stream (Redis TTL may have expired — BigQuery remains the source of truth).
                    </div>
                  )}

                  {/* Footer: job_id */}
                  <div style={{ padding: "8px 16px", fontSize: 11, color: "#9ca3af", fontFamily: "ui-monospace, monospace" }}>
                    job_id: {r.job_id}
                  </div>
                </td>
              </tr>,
            );
          }
          return out;
        }) : (
          <tr><td style={{ ...td, textAlign: "center", color: "#6b7280" }} colSpan={9}>
            {loading ? "Loading…" : "No clip exports yet"}
          </td></tr>
        )}
      </tbody>
    </table>
  );
}

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: "8px 20px",
  background: "transparent",
  border: "none",
  borderBottom: active ? "2px solid #111827" : "2px solid transparent",
  fontSize: 14,
  fontWeight: active ? 600 : 500,
  color: active ? "#111827" : "#6b7280",
  cursor: "pointer",
  marginBottom: -1,
});

const btn: React.CSSProperties = {
  padding: "6px 12px", background: "white", border: "1px solid #d1d5db", borderRadius: 6,
  fontSize: 13, cursor: "pointer",
};
const th: React.CSSProperties = { padding: "8px 12px", fontWeight: 600, fontSize: 12, textTransform: "uppercase", color: "#6b7280" };
const td: React.CSSProperties = { padding: "8px 12px", verticalAlign: "top" };
const subTh: React.CSSProperties = { padding: "6px 16px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", color: "#6b7280" };
const subTd: React.CSSProperties = { padding: "6px 16px", verticalAlign: "top" };
