"use client";

interface Props {
  selectionValid: boolean;
  clipDurationSec: number;
  exporting: boolean;
  exportStatus: string;
  resolution: 720 | 1080;
  onResolutionChange: (res: 720 | 1080) => void;
  onExport: () => void;
}

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SnippyExportBar({
  selectionValid,
  clipDurationSec,
  exporting,
  exportStatus,
  resolution,
  onResolutionChange,
  onExport,
}: Props) {
  const isError = exportStatus.startsWith("Error");

  return (
    <div
      className="snippy-card flex items-center gap-2"
      style={{ padding: "10px 12px" }}
    >
      <div className="flex items-center gap-2">
        <select
          value={resolution}
          onChange={(e) => onResolutionChange(Number(e.target.value) as 720 | 1080)}
          disabled={exporting}
          className="font-mono"
          style={{
            fontSize: 11,
            color: "var(--snippy-text-secondary)",
            background: "transparent",
            border: "1px solid var(--snippy-border, #ccc)",
            borderRadius: 3,
            padding: "2px 4px",
            cursor: exporting ? "not-allowed" : "pointer",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <option value={1080}>1080p</option>
          <option value={720}>720p</option>
        </select>
        <span
          className="font-mono"
          style={{
            fontSize: 11,
            color: "var(--snippy-text-secondary)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          · {fmt(clipDurationSec)}
        </span>
      </div>

      <div className="flex-1" />

      {exportStatus && (
        <div
          className="text-[11px]"
          style={{
            color: isError ? "#b94a2e" : "var(--snippy-text-secondary)",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={exportStatus}
        >
          {exportStatus}
        </div>
      )}

      <button
        onClick={onExport}
        disabled={!selectionValid || exporting}
        className="text-[12px] font-medium rounded px-3 py-1.5"
        style={{
          background: "var(--snippy-accent)",
          color: "#fff",
          opacity: !selectionValid || exporting ? 0.5 : 1,
          cursor: !selectionValid || exporting ? "not-allowed" : "pointer",
        }}
      >
        {exporting ? "Rendering…" : "Export MP4"}
      </button>
    </div>
  );
}
