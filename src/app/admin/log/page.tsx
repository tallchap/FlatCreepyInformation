"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
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

function fmt(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function statusColor(s: string) {
  if (s === "error") return "#dc2626";
  if (s === "success") return "#16a34a";
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

  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ key, page: String(page), pageSize: "50" });
      if (videoId) qs.set("videoId", videoId);
      const res = await fetch(`/api/admin/log?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e: any) {
      setError(e.message || "Load failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [key, page, videoId]);

  useEffect(() => { load(); }, [load]);

  if (!key) {
    return (
      <main style={{ padding: 40, fontFamily: "system-ui" }}>
        <h1>Admin Log</h1>
        <p>Missing <code>?key=</code> in URL.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Pipeline Log</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {videoId && (
            <>
              <span style={{ fontSize: 13, color: "#6b7280" }}>
                Filtered: <code>{videoId}</code>
              </span>
              <button onClick={() => { setVideoId(null); setPage(1); }}
                      style={btn}>Clear filter</button>
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
            <th style={th}>Time</th>
            <th style={th}>Video</th>
            <th style={th}>Pipeline</th>
            <th style={th}>Step</th>
            <th style={th}>Status</th>
            <th style={th}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {data?.events?.length ? data.events.map((e, i) => (
            <tr key={i} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td style={td}>{fmt(e.ts)}</td>
              <td style={td}>
                <button
                  onClick={() => { setVideoId(e.videoId); setPage(1); }}
                  style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, fontFamily: "ui-monospace, monospace" }}
                >
                  {e.videoId}
                </button>
              </td>
              <td style={td}>{e.pipeline}</td>
              <td style={td}><code>{e.step}</code></td>
              <td style={{ ...td, color: statusColor(e.status), fontWeight: 500 }}>{e.status}</td>
              <td style={td}>
                {e.detail ? <code style={{ fontSize: 11 }}>{typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}</code> : "—"}
              </td>
            </tr>
          )) : (
            <tr><td style={{ ...td, textAlign: "center", color: "#6b7280" }} colSpan={6}>
              {loading ? "Loading…" : "No events"}
            </td></tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} style={btn}>Prev</button>
        <span style={{ fontSize: 13, color: "#6b7280" }}>
          Page {data?.page ?? page} · {data?.events?.length ?? 0} shown{data ? ` of ${data.total}` : ""}
        </span>
        <button onClick={() => setPage((p) => p + 1)} disabled={!data?.hasMore || loading} style={btn}>Next</button>
      </div>
    </main>
  );
}

const btn: React.CSSProperties = {
  padding: "6px 12px", background: "white", border: "1px solid #d1d5db", borderRadius: 6,
  fontSize: 13, cursor: "pointer",
};
const th: React.CSSProperties = { padding: "8px 12px", fontWeight: 600, fontSize: 12, textTransform: "uppercase", color: "#6b7280" };
const td: React.CSSProperties = { padding: "8px 12px", verticalAlign: "top" };
