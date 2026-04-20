"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  duration: number;
  startSec: number | null;
  endSec: number | null;
  playheadSec: number;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onJumpIn: () => void;
  onJumpOut: () => void;
  onPlaySelection: () => void;
  onFit: () => void;
  onClear: () => void;
  onStartSec: (sec: number) => void;
  onEndSec: (sec: number) => void;
}

function fmt(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return "—:—";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function parseTime(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d+):(\d{1,2}(?:\.\d{0,3})?)$/);
  if (m) {
    return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  }
  const num = parseFloat(trimmed);
  return isNaN(num) ? null : num;
}

function TimeField({
  value,
  onCommit,
  placeholder,
  disabled,
}: {
  value: number | null;
  onCommit: (sec: number) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value == null ? "" : fmt(value));
  const prev = useRef(value);
  useEffect(() => {
    if (value !== prev.current) {
      setText(value == null ? "" : fmt(value));
      prev.current = value;
    }
  }, [value]);

  const commit = () => {
    const parsed = parseTime(text);
    if (parsed != null && parsed >= 0) {
      onCommit(parsed);
      prev.current = parsed;
      setText(fmt(parsed));
    } else {
      setText(value == null ? "" : fmt(value));
    }
  };

  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(value == null ? "" : fmt(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-20 text-center rounded font-mono text-xs"
      style={{
        border: "1px solid var(--snippy-border)",
        background: disabled ? "transparent" : "var(--snippy-card)",
        padding: "4px 6px",
        color: "var(--snippy-accent)",
        fontWeight: 600,
      }}
    />
  );
}

export function SnippyClipToolbar({
  duration,
  startSec,
  endSec,
  playheadSec,
  onMarkIn,
  onMarkOut,
  onJumpIn,
  onJumpOut,
  onPlaySelection,
  onFit,
  onClear,
  onStartSec,
  onEndSec,
}: Props) {
  const selectionValid = startSec != null && endSec != null && endSec > startSec;
  const clipDur = selectionValid ? endSec! - startSec! : 0;

  return (
    <div className="snippy-card flex flex-wrap items-center gap-2 py-3 px-4">
      <button
        onClick={onMarkIn}
        className="snippy-btn-ghost text-sm"
        title="Mark IN at playhead (I)"
      >
        <span className="font-mono mr-1.5">[</span>Mark IN
      </button>
      <button
        onClick={onMarkOut}
        disabled={startSec == null || playheadSec <= startSec}
        className="snippy-btn-ghost text-sm"
        title="Mark OUT at playhead (O)"
      >
        Mark OUT<span className="font-mono ml-1.5">]</span>
      </button>

      <div
        className="w-px h-5 mx-1"
        style={{ background: "var(--snippy-border)" }}
      />

      <button
        onClick={onJumpIn}
        disabled={startSec == null}
        className="snippy-btn-ghost text-sm"
        title="Jump to IN ([)"
      >
        ⇤ IN
      </button>
      <button
        onClick={onJumpOut}
        disabled={endSec == null}
        className="snippy-btn-ghost text-sm"
        title="Jump to OUT (])"
      >
        OUT ⇥
      </button>
      <button
        onClick={onPlaySelection}
        disabled={!selectionValid}
        className="snippy-btn-primary text-sm"
        title="Play selection"
      >
        ▶ Play selection
      </button>

      <div className="flex-1" />

      <div className="flex items-center gap-1 text-xs">
        <span className="snippy-label" style={{ fontSize: 10 }}>
          IN
        </span>
        <TimeField
          value={startSec}
          placeholder="—:—"
          onCommit={(sec) => onStartSec(Math.max(0, Math.min(duration, sec)))}
        />
        <span style={{ color: "var(--snippy-text-secondary)" }}>→</span>
        <span className="snippy-label" style={{ fontSize: 10 }}>
          OUT
        </span>
        <TimeField
          value={endSec}
          placeholder="—:—"
          onCommit={(sec) => onEndSec(Math.max(0, Math.min(duration, sec)))}
        />
        <span
          className="ml-2 snippy-label"
          style={{ fontSize: 11 }}
        >
          {selectionValid ? `${clipDur.toFixed(2)}s` : "no selection"}
        </span>
      </div>

      <button onClick={onFit} className="snippy-btn-ghost text-xs" title="Fit full timeline">
        Fit
      </button>
      <button
        onClick={onClear}
        disabled={!selectionValid && startSec == null && endSec == null}
        className="snippy-btn-ghost text-xs"
        title="Clear selection"
      >
        Clear
      </button>
      <span
        className="snippy-label ml-2"
        style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}
      >
        playhead {fmt(playheadSec)} · total {fmt(duration)}
      </span>
    </div>
  );
}
