"use client";

import { useEffect, useState } from "react";

interface BunnyItem {
  guid: string;
  title: string;
  length: number;
  width: number;
  height: number;
  status: number;
  encodeProgress: number;
  availableResolutions: string;
  dateUploaded?: string;
  playable: boolean;
  mp4Url: string | null;
  hlsUrl: string | null;
  thumbUrl: string | null;
}

interface Props {
  onSelect: (video: BunnyItem) => void;
  selectedGuid?: string | null;
  collapsed?: boolean;
  selectedVideo?: BunnyItem | null;
  onExpand?: () => void;
}

function formatDuration(sec: number): string {
  if (!sec || isNaN(sec)) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SnippyBunnyPicker({
  onSelect,
  selectedGuid,
  collapsed,
  selectedVideo,
  onExpand,
}: Props) {
  const [items, setItems] = useState<BunnyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ itemsPerPage: "50" });
    if (search.trim()) qs.set("search", search.trim());
    fetch(`/api/bunny/videos?${qs}`)
      .then(async (r) => {
        if (!r.ok) {
          const txt = await r.text();
          throw new Error(txt.slice(0, 200) || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items || []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Load failed";
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, collapsed]);

  if (collapsed && selectedVideo) {
    return (
      <div
        className="snippy-card flex items-center gap-3 py-2 px-3"
        style={{ padding: "10px 14px" }}
      >
        <div
          className="w-16 h-9 rounded overflow-hidden flex-shrink-0"
          style={{ background: "var(--snippy-canvas)" }}
        >
          {selectedVideo.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={selectedVideo.thumbUrl}
              alt={selectedVideo.title}
              className="w-full h-full object-cover"
            />
          ) : null}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="text-sm font-medium truncate"
            style={{ color: "var(--snippy-text)" }}
            title={selectedVideo.title}
          >
            {selectedVideo.title || selectedVideo.guid.slice(0, 8)}
          </div>
          <div
            className="text-xs"
            style={{ color: "var(--snippy-text-secondary)" }}
          >
            {formatDuration(selectedVideo.length)} &middot;{" "}
            {selectedVideo.availableResolutions || "—"}
          </div>
        </div>
        <button onClick={onExpand} className="snippy-btn-ghost text-xs">
          Change source
        </button>
      </div>
    );
  }

  return (
    <div className="snippy-card">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2
          className="text-base font-medium"
          style={{ color: "var(--snippy-text)" }}
        >
          Pick a Bunny Stream video
        </h2>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title..."
          className="flex-1 max-w-xs rounded-md px-3 py-1.5 text-sm"
          style={{
            border: "1px solid var(--snippy-border)",
            background: "var(--snippy-card)",
          }}
        />
      </div>

      {loading && (
        <div
          className="text-sm py-8 text-center"
          style={{ color: "var(--snippy-text-secondary)" }}
        >
          Loading…
        </div>
      )}
      {error && (
        <div
          className="text-sm py-3 px-3 rounded-md"
          style={{
            color: "#b94a2e",
            background: "rgba(185,74,46,0.08)",
            border: "1px solid rgba(185,74,46,0.3)",
          }}
        >
          {error}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div
          className="text-sm py-8 text-center"
          style={{ color: "var(--snippy-text-secondary)" }}
        >
          No videos found in library 627230.
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 max-h-[420px] overflow-y-auto">
          {items.map((v) => {
            const selected = v.guid === selectedGuid;
            const disabled = !v.playable || !v.mp4Url;
            return (
              <button
                key={v.guid}
                disabled={disabled}
                onClick={() => onSelect(v)}
                className="text-left rounded-xl overflow-hidden transition-colors"
                style={{
                  border: `2px solid ${
                    selected
                      ? "var(--snippy-accent)"
                      : "var(--snippy-border)"
                  }`,
                  background: selected
                    ? "var(--snippy-selection)"
                    : "var(--snippy-card)",
                  opacity: disabled ? 0.5 : 1,
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                <div
                  className="aspect-video relative"
                  style={{ background: "var(--snippy-canvas)" }}
                >
                  {v.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={v.thumbUrl}
                      alt={v.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div
                      className="w-full h-full flex items-center justify-center text-xs"
                      style={{ color: "var(--snippy-text-secondary)" }}
                    >
                      no thumb
                    </div>
                  )}
                  {v.length > 0 && (
                    <div
                      className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded"
                      style={{
                        background: "rgba(0,0,0,0.7)",
                        color: "#ffffff",
                      }}
                    >
                      {formatDuration(v.length)}
                    </div>
                  )}
                  {!v.playable && (
                    <div
                      className="absolute inset-0 flex items-center justify-center text-xs"
                      style={{
                        background: "rgba(0,0,0,0.5)",
                        color: "#ffffff",
                      }}
                    >
                      Encoding {v.encodeProgress}%
                    </div>
                  )}
                </div>
                <div
                  className="px-2 py-1.5 text-xs font-medium line-clamp-2"
                  style={{ color: "var(--snippy-text)" }}
                >
                  {v.title || v.guid.slice(0, 8)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export type { BunnyItem };
