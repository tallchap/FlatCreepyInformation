"use client";

import { useState } from "react";
import type { OverlaySettings } from "./types";
import { SNIPPY_FONT_FAMILIES } from "./snippy-fonts";

const GOOGLE_FONTS = SNIPPY_FONT_FAMILIES;

interface Props {
  overlays: OverlaySettings[];
  clipDurationSec: number;
  positioningId: string | null;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onChange: (id: string, patch: Partial<OverlaySettings>) => void;
  onStartPositioning: (id: string | null) => void;
  forceExpanded?: boolean;
}

function fmtDur(sec: number): string {
  if (sec < 0 || isNaN(sec)) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function SnippyOverlayList({
  overlays,
  clipDurationSec,
  positioningId,
  onAdd,
  onRemove,
  onChange,
  onStartPositioning,
}: Props) {
  return (
    <div className="snippy-card">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3
            className="text-sm font-semibold"
            style={{ color: "var(--snippy-text)" }}
          >
            Overlays
          </h3>
          {overlays.length > 0 && (
            <span
              className="snippy-label"
              style={{ fontSize: 9, letterSpacing: 0, textTransform: "none" }}
            >
              · {overlays.length} · clip-time
            </span>
          )}
        </div>
        <button
          onClick={onAdd}
          className="text-[12px] px-3 py-1.5 rounded font-medium"
          style={{ background: "var(--snippy-accent)", color: "#fff", letterSpacing: "0.02em" }}
        >
          + Add Text Overlay
        </button>
      </div>

      {overlays.length === 0 ? (
        <div
          className="text-[11px] py-3 px-2 text-center rounded"
          style={{
            color: "var(--snippy-text-secondary)",
            background: "var(--snippy-canvas)",
            border: "1px dashed var(--snippy-border)",
          }}
        >
          No overlays. Click + Add to drop text on the clip.
        </div>
      ) : (
        <div className="space-y-1.5">
          {overlays.map((o) => (
            <OverlayRow
              key={o.id}
              overlay={o}
              clipDurationSec={clipDurationSec}
              positioning={positioningId === o.id}
              onRemove={() => onRemove(o.id)}
              onChange={(patch) => onChange(o.id, patch)}
              onStartPositioning={() =>
                onStartPositioning(positioningId === o.id ? null : o.id)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OverlayRow({
  overlay,
  clipDurationSec,
  positioning,
  onRemove,
  onChange,
  onStartPositioning,
}: {
  overlay: OverlaySettings;
  clipDurationSec: number;
  positioning: boolean;
  onRemove: () => void;
  onChange: (patch: Partial<OverlaySettings>) => void;
  onStartPositioning: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const setNumber = (
    key: keyof OverlaySettings,
    raw: string,
    min: number,
    max: number
  ) => {
    const v = parseFloat(raw);
    if (isNaN(v)) return;
    onChange({ [key]: Math.max(min, Math.min(max, v)) } as Partial<OverlaySettings>);
  };

  return (
    <div
      className="rounded-md p-1.5"
      style={{
        background: "var(--snippy-canvas)",
        border: `1px solid ${
          positioning ? "var(--snippy-accent)" : "var(--snippy-border)"
        }`,
      }}
    >
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={overlay.text}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="overlay text…"
          className="flex-1 px-1.5 py-1 text-[12px] rounded"
          style={{
            fontFamily: `'${overlay.fontFamily}', sans-serif`,
            color: overlay.color,
            background: overlay.bgBox
              ? overlay.bgColor + "40"
              : "var(--snippy-card)",
            border: "1px solid var(--snippy-border)",
          }}
        />
        <input
          type="number"
          step={0.1}
          min={0}
          max={clipDurationSec}
          value={overlay.startSec.toFixed(1)}
          onChange={(e) =>
            setNumber("startSec", e.target.value, 0, overlay.endSec - 0.1)
          }
          className="w-12 px-1 py-1 text-[10px] rounded font-mono"
          style={{
            border: "1px solid var(--snippy-border)",
            background: "var(--snippy-card)",
          }}
          title="start (clip sec)"
        />
        <span style={{ color: "var(--snippy-text-secondary)", fontSize: 10 }}>
          →
        </span>
        <input
          type="number"
          step={0.1}
          min={0}
          max={clipDurationSec}
          value={overlay.endSec.toFixed(1)}
          onChange={(e) =>
            setNumber(
              "endSec",
              e.target.value,
              overlay.startSec + 0.1,
              clipDurationSec
            )
          }
          className="w-12 px-1 py-1 text-[10px] rounded font-mono"
          style={{
            border: "1px solid var(--snippy-border)",
            background: "var(--snippy-card)",
          }}
          title="end (clip sec)"
        />
        <button
          onClick={onStartPositioning}
          className="text-[10px] px-1.5 py-1 rounded"
          style={{
            border: `1px solid ${
              positioning ? "var(--snippy-accent)" : "var(--snippy-border)"
            }`,
            color: positioning ? "var(--snippy-accent)" : "var(--snippy-text-secondary)",
            background: positioning ? "var(--snippy-selection)" : "transparent",
          }}
          title="Drag on preview to position"
        >
          ◎
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] px-1.5 py-1 rounded"
          style={{
            border: "1px solid var(--snippy-border)",
            color: "var(--snippy-text-secondary)",
          }}
          title={expanded ? "Hide style" : "Show style"}
        >
          {expanded ? "–" : "⋯"}
        </button>
        <button
          onClick={onRemove}
          className="text-[10px] px-1.5 py-1 rounded"
          style={{
            border: "1px solid var(--snippy-border)",
            color: "var(--snippy-text-secondary)",
          }}
          title="Remove"
        >
          ×
        </button>
      </div>

      {expanded && (
        <div
          className="mt-1.5 pt-1.5 space-y-1.5"
          style={{ borderTop: "1px solid var(--snippy-border)" }}
        >
          <div className="flex items-center gap-2">
            <select
              value={overlay.fontFamily}
              onChange={(e) => onChange({ fontFamily: e.target.value })}
              className="text-[10px] px-1.5 py-1 rounded flex-1 min-w-0"
              style={{
                border: "1px solid var(--snippy-border)",
                background: "var(--snippy-card)",
                fontFamily: `'${overlay.fontFamily}', sans-serif`,
              }}
            >
              {GOOGLE_FONTS.map((f) => (
                <option
                  key={f}
                  value={f}
                  style={{ fontFamily: `'${f}', sans-serif` }}
                >
                  {f}
                </option>
              ))}
            </select>
            <MiniField
              label="size"
              value={overlay.fontSize}
              min={24}
              max={192}
              onChange={(v) => onChange({ fontSize: v })}
            />
          </div>
          <div className="flex items-center gap-2">
            <MiniField
              label="x"
              value={Math.round(overlay.xPct * 100)}
              min={0}
              max={100}
              suffix="%"
              onChange={(v) => onChange({ xPct: v / 100 })}
            />
            <MiniField
              label="y"
              value={Math.round(overlay.yPct * 100)}
              min={0}
              max={100}
              suffix="%"
              onChange={(v) => onChange({ yPct: v / 100 })}
            />
            <MiniField
              label="op"
              value={overlay.opacity}
              min={10}
              max={100}
              suffix="%"
              onChange={(v) => onChange({ opacity: v })}
            />
          </div>
          <div
            className="flex items-center gap-2"
            style={{ fontSize: 10, color: "var(--snippy-text-secondary)" }}
          >
            <SwatchMini
              label="text"
              value={overlay.color}
              onChange={(v) => onChange({ color: v })}
            />
            <label className="flex items-center gap-1 cursor-pointer ml-2">
              <input
                type="checkbox"
                checked={overlay.bgBox}
                onChange={(e) => onChange({ bgBox: e.target.checked })}
                className="scale-90"
              />
              bg
            </label>
            {overlay.bgBox && (
              <>
                <SwatchMini
                  value={overlay.bgColor}
                  onChange={(v) => onChange({ bgColor: v })}
                />
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={overlay.bgOpacity}
                  onChange={(e) =>
                    onChange({ bgOpacity: Number(e.target.value) })
                  }
                  className="snippy-range flex-1"
                />
                <span
                  className="font-mono"
                  style={{ fontSize: 9, minWidth: 22, textAlign: "right" }}
                >
                  {overlay.bgOpacity}%
                </span>
              </>
            )}
            <div className="flex-1" />
            <button
              onClick={() =>
                onChange({ startSec: 0, endSec: clipDurationSec })
              }
              style={{
                fontSize: 9,
                color: "var(--snippy-text-secondary)",
                textDecoration: "underline",
                background: "transparent",
                border: 0,
                cursor: "pointer",
                padding: 0,
              }}
            >
              full clip · {fmtDur(overlay.endSec - overlay.startSec)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniField({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <span
        style={{
          fontSize: 9,
          textTransform: "uppercase",
          color: "var(--snippy-text-secondary)",
          letterSpacing: "0.04em",
          minWidth: 20,
        }}
      >
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="snippy-range flex-1"
      />
      <span
        className="font-mono"
        style={{
          fontSize: 9,
          minWidth: 26,
          textAlign: "right",
          color: "var(--snippy-text)",
        }}
      >
        {value}
        {suffix || ""}
      </span>
    </div>
  );
}

function SwatchMini({
  label,
  value,
  onChange,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label
      className="flex items-center gap-1 cursor-pointer"
      title={`${label ?? "color"}: ${value}`}
    >
      <span
        className="snippy-swatch"
        style={{ background: value, position: "relative" }}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            opacity: 0,
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
        />
      </span>
      {label && <span style={{ fontSize: 9 }}>{label}</span>}
    </label>
  );
}
