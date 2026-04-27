"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";

interface OverlayInfo {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  bgColor?: string;
}

interface Props {
  duration: number;
  startSec: number | null;
  endSec: number | null;
  playheadSec: number;
  isPlaying: boolean;
  overlays: OverlayInfo[];
  captionCount: number;
  selectedLayerId: string | null;
  playbackRate: number;
  volume: number;
  onStartChange: (sec: number) => void;
  onEndChange: (sec: number) => void;
  onSeek: (sec: number) => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onTogglePlay: () => void;
  onPlaybackRateChange: (rate: number) => void;
  onVolumeChange: (vol: number) => void;
  onLayerSelect: (id: string | null) => void;
  onFit: () => void;
  laneAreaHeight?: number;
  hideMarks?: boolean;
  onOverlayTimingChange?: (id: string, startSec: number, endSec: number) => void;
  videoUrl?: string;
}

export interface SnippyTimelineHandle {
  fit: () => void;
  zoomAround: (sec: number, scale: number) => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 30;
const LANE_H = 32;
const VIDEO_LANE_H = 56;
const RULER_H = 24;
const TRANSPORT_H = 36;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const LANE_COLORS = ["#D97757", "#4ECDC4", "#FFE66D", "#A8E6CF", "#FF6B6B"];

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

function fmtTick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function chooseStepSec(visibleWindowSec: number, visiblePx: number): number {
  const minPxPerTick = 80;
  const targetTicks = Math.max(2, Math.floor(visiblePx / minPxPerTick));
  const raw = visibleWindowSec / targetTicks;
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const c of candidates) if (c >= raw) return c;
  return 3600;
}

export const SnippyTimeline = forwardRef<SnippyTimelineHandle, Props>(
  function SnippyTimeline(
    {
      duration, startSec, endSec, playheadSec, isPlaying, overlays, captionCount,
      selectedLayerId, playbackRate, volume,
      onStartChange, onEndChange, onSeek, onMarkIn, onMarkOut, onTogglePlay,
      onPlaybackRateChange, onVolumeChange, onLayerSelect, onFit: onFitProp, laneAreaHeight = 160, hideMarks = false,
      onOverlayTimingChange,
      videoUrl,
    },
    ref
  ) {
    const outerRef = useRef<HTMLDivElement>(null);
    const fallbackBars = useRef(Array.from({ length: 200 }, () => 6 + Math.random() * (VIDEO_LANE_H - 16))).current;
    const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(null);

    useEffect(() => {
      if (!videoUrl) return;
      let cancelled = false;
      const SAMPLE_COUNT = 500;
      (async () => {
        try {
          const resp = await fetch(videoUrl);
          if (cancelled || !resp.ok) return;
          const buf = await resp.arrayBuffer();
          if (cancelled) return;
          const ctx = new AudioContext();
          const audio = await ctx.decodeAudioData(buf);
          if (cancelled) { ctx.close(); return; }
          const ch = audio.getChannelData(0);
          const blockSize = Math.floor(ch.length / SAMPLE_COUNT);
          const peaks: number[] = [];
          for (let i = 0; i < SAMPLE_COUNT; i++) {
            let max = 0;
            const start = i * blockSize;
            for (let j = start; j < start + blockSize && j < ch.length; j++) {
              const abs = Math.abs(ch[j]);
              if (abs > max) max = abs;
            }
            peaks.push(max);
          }
          if (!cancelled) setWaveformPeaks(peaks);
          ctx.close();
        } catch {
          // fall back to random bars
        }
      })();
      return () => { cancelled = true; };
    }, [videoUrl]);

    const waveformBars = waveformPeaks
      ? waveformPeaks.map((p) => 6 + p * (VIDEO_LANE_H - 16))
      : fallbackBars;
    const contentRef = useRef<HTMLDivElement>(null);
    const [viewportWidth, setViewportWidth] = useState(1000);
    const [zoom, setZoom] = useState(1);
    const [, setScrollTick] = useState(0);
    const [dragging, setDragging] = useState<"start" | "end" | "playhead" | null>(null);
    const [overlayDrag, setOverlayDrag] = useState<{ id: string; edge: "start" | "end" | "move"; initX: number; initStart: number; initEnd: number } | null>(null);

    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const contentWidth = Math.max(viewportWidth, viewportWidth * clampedZoom);

    const hasCaptions = captionCount > 0;
    const laneCount = 1 + (hasCaptions ? 1 : 0) + overlays.length;
    const lanesH = VIDEO_LANE_H + (hasCaptions ? LANE_H : 0) + overlays.length * LANE_H;

    useEffect(() => {
      const el = outerRef.current;
      if (!el) return;
      const ro = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width));
      ro.observe(el);
      setViewportWidth(el.clientWidth);
      const onScroll = () => setScrollTick((n) => n + 1);
      el.addEventListener("scroll", onScroll, { passive: true });
      return () => { ro.disconnect(); el.removeEventListener("scroll", onScroll); };
    }, []);

    const pxToSec = useCallback((px: number) => (px / contentWidth) * duration, [contentWidth, duration]);
    const secToPx = useCallback((sec: number) => (sec / duration) * contentWidth, [duration, contentWidth]);

    const pointerEventToSec = useCallback((e: { clientX: number }) => {
      if (!contentRef.current) return 0;
      const rect = contentRef.current.getBoundingClientRect();
      return Math.max(0, Math.min(duration, pxToSec(e.clientX - rect.left)));
    }, [duration, pxToSec]);

    const zoomAround = useCallback((anchorSec: number, scale: number) => {
      if (!outerRef.current) return;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, clampedZoom * scale));
      if (newZoom === clampedZoom) return;
      const prevContentWidth = Math.max(viewportWidth, viewportWidth * clampedZoom);
      const prevAnchorPx = (anchorSec / duration) * prevContentWidth;
      const anchorViewportOffset = prevAnchorPx - outerRef.current.scrollLeft;
      setZoom(newZoom);
      requestAnimationFrame(() => {
        if (!outerRef.current) return;
        const newContentWidth = Math.max(viewportWidth, viewportWidth * newZoom);
        const newAnchorPx = (anchorSec / duration) * newContentWidth;
        outerRef.current.scrollLeft = Math.max(0, Math.min(newContentWidth - outerRef.current.clientWidth, newAnchorPx - anchorViewportOffset));
      });
    }, [clampedZoom, viewportWidth, duration]);

    const fit = useCallback(() => { setZoom(1); if (outerRef.current) outerRef.current.scrollLeft = 0; }, []);

    useImperativeHandle(ref, () => ({ fit, zoomAround }), [fit, zoomAround]);

    useEffect(() => {
      const el = outerRef.current;
      if (!el) return;
      const handler = (e: WheelEvent) => {
        if (e.shiftKey) return;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        const rect = contentRef.current!.getBoundingClientRect();
        const anchorSec = ((e.clientX - rect.left) / contentWidth) * duration;
        zoomAround(Math.max(0, Math.min(duration, anchorSec)), e.deltaY > 0 ? 1 / 1.2 : 1.2);
      };
      el.addEventListener("wheel", handler, { passive: false });
      return () => el.removeEventListener("wheel", handler);
    }, [zoomAround, contentWidth, duration]);

    useEffect(() => {
      const el = outerRef.current;
      if (!el) return;
      const playheadPx = secToPx(playheadSec);
      const visibleStart = el.scrollLeft;
      const visibleEnd = visibleStart + el.clientWidth;
      const margin = 40;
      if (playheadPx < visibleStart + margin) el.scrollLeft = Math.max(0, playheadPx - margin);
      else if (playheadPx > visibleEnd - margin) el.scrollLeft = Math.min(contentWidth - el.clientWidth, playheadPx - el.clientWidth + margin);
    }, [playheadSec, secToPx, contentWidth]);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, kind: "start" | "end" | "playhead" | "track") => {
      if (!contentRef.current) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const sec = pointerEventToSec(e);
      if (kind === "track") { onSeek(sec); setDragging("playhead"); }
      else setDragging(kind);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const raw = pointerEventToSec(e);
      const snap = e.shiftKey ? Math.round(raw) : raw;
      const clamped = Math.max(0, Math.min(duration, snap));
      if (dragging === "start") onStartChange(Math.min(clamped, endSec != null ? endSec - 0.1 : duration));
      else if (dragging === "end") onEndChange(Math.max(clamped, startSec != null ? startSec + 0.1 : 0));
      else if (dragging === "playhead") onSeek(clamped);
    };

    const onPointerUp = () => setDragging(null);

    const visibleStartSec = outerRef.current ? (outerRef.current.scrollLeft / contentWidth) * duration : 0;
    const visibleEndSec = outerRef.current ? ((outerRef.current.scrollLeft + outerRef.current.clientWidth) / contentWidth) * duration : duration;
    const visibleWindowSec = Math.max(0.1, visibleEndSec - visibleStartSec || duration);
    const stepSec = useMemo(() => chooseStepSec(visibleWindowSec, viewportWidth), [visibleWindowSec, viewportWidth]);

    const ticks = useMemo(() => {
      const first = Math.floor(visibleStartSec / stepSec) * stepSec;
      const out: number[] = [];
      for (let t = first; t <= visibleEndSec + stepSec; t += stepSec) {
        if (t >= 0 && t <= duration) out.push(t);
      }
      return out;
    }, [visibleStartSec, visibleEndSec, stepSec, duration]);

    const selActive = startSec != null && endSec != null && endSec > startSec;
    const clipDuration = selActive ? endSec! - startSec! : 0;

    const btnStyle = {
      fontSize: 11,
      padding: "3px 8px",
      background: "transparent",
      border: "1px solid var(--snippy-border)",
      borderRadius: 4,
      color: "var(--snippy-text-secondary)",
      cursor: "pointer",
    } as const;

    const zoomCenter = () => {
      if (!outerRef.current) return duration / 2;
      return ((outerRef.current.scrollLeft + outerRef.current.clientWidth / 2) / contentWidth) * duration;
    };

    return (
      <div
        style={{
          background: "var(--snippy-card)",
          border: "1px solid var(--snippy-border)",
          borderRadius: 12,
          overflow: "hidden",
          width: "100%",
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        {/* Transport row */}
        <div
          style={{
            height: TRANSPORT_H,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            borderBottom: "1px solid var(--snippy-border)",
            fontSize: 11,
          }}
        >
          {!hideMarks && (<>
            <button onClick={onMarkIn} style={{ ...btnStyle, background: "#A0522D", color: "#fff", border: "none" }} title="Mark IN (I)">[ Mark IN</button>
            <button onClick={onMarkOut} style={{ ...btnStyle, background: "#A0522D", color: "#fff", border: "none" }} title="Mark OUT (O)">Mark OUT ]</button>
            <div style={{ width: 1, height: 16, background: "var(--snippy-border)", margin: "0 4px" }} />
          </>)}

          <button
            onClick={() => { if (startSec != null) { onSeek(startSec); } }}
            disabled={startSec == null}
            style={{ ...btnStyle, background: "#4A7C59", color: "#fff", border: "none", opacity: startSec == null ? 0.3 : 1, cursor: startSec == null ? "not-allowed" : "pointer" }}
            title="Jump to Mark IN"
          >⇤ Start</button>
          <button
            onClick={onTogglePlay}
            style={{ ...btnStyle, background: "#4A7C59", color: "#fff", border: "none" }}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button
            onClick={() => { if (endSec != null) { onSeek(Math.max(0, endSec - 3)); } }}
            disabled={endSec == null}
            style={{ ...btnStyle, background: "#4A7C59", color: "#fff", border: "none", opacity: endSec == null ? 0.3 : 1, cursor: endSec == null ? "not-allowed" : "pointer" }}
            title="Play last 3s before Mark OUT"
          >Last 3s ⇥</button>

          <div style={{ width: 1, height: 16, background: "var(--snippy-border)", margin: "0 2px" }} />

          {/* Seek arrows */}
          <button
            onClick={() => onSeek(Math.max(0, playheadSec - 5))}
            style={{ ...btnStyle, background: "var(--snippy-canvas)", border: "1px solid var(--snippy-border)" }}
            title="Rewind 5s (←)"
          >← 5s</button>
          <button
            onClick={() => onSeek(Math.min(duration, playheadSec + 5))}
            style={{ ...btnStyle, background: "var(--snippy-canvas)", border: "1px solid var(--snippy-border)" }}
            title="Forward 5s (→)"
          >5s →</button>

          {!hideMarks && startSec != null && (<>
            <div style={{ width: 1, height: 16, background: "var(--snippy-border)", margin: "0 2px" }} />
            <button
              onClick={() => onStartChange(Math.max(0, startSec - 1/30))}
              style={{ ...btnStyle, background: "var(--snippy-canvas)", border: "1px solid var(--snippy-border)", fontSize: 9 }}
              title="Nudge IN left 1 frame"
            >◀ IN</button>
            <button
              onClick={() => onStartChange(Math.min(endSec ?? duration, startSec + 1/30))}
              style={{ ...btnStyle, background: "var(--snippy-canvas)", border: "1px solid var(--snippy-border)", fontSize: 9 }}
              title="Nudge IN right 1 frame"
            >IN ▶</button>
          </>)}

          {!hideMarks && endSec != null && (<>
            <button
              onClick={() => onEndChange(Math.max(startSec ?? 0, endSec - 1/30))}
              style={{ ...btnStyle, background: "var(--snippy-canvas)", border: "1px solid var(--snippy-border)", fontSize: 9 }}
              title="Nudge OUT left 1 frame"
            >◀ OUT</button>
            <button
              onClick={() => onEndChange(Math.min(duration, endSec + 1/30))}
              style={{ ...btnStyle, background: "var(--snippy-canvas)", border: "1px solid var(--snippy-border)", fontSize: 9 }}
              title="Nudge OUT right 1 frame"
            >OUT ▶</button>
          </>)}

          <span
            className="font-mono"
            style={{ fontSize: 10, color: "var(--snippy-text-secondary)", fontVariantNumeric: "tabular-nums", minWidth: 90 }}
          >
            {fmtTime(playheadSec)} / {fmtTime(duration)}
          </span>

          {selActive && (
            <span style={{ fontSize: 9, color: "var(--snippy-text-secondary)", opacity: 0.7 }}>
              clip {clipDuration.toFixed(1)}s
            </span>
          )}

          <div style={{ flex: 1 }} />

          <button
            onClick={() => {
              const idx = SPEEDS.indexOf(playbackRate);
              if (idx > 0) onPlaybackRateChange(SPEEDS[idx - 1]);
            }}
            disabled={SPEEDS.indexOf(playbackRate) <= 0}
            style={{ ...btnStyle, fontSize: 9, padding: "2px 5px", opacity: SPEEDS.indexOf(playbackRate) <= 0 ? 0.3 : 1 }}
            title="Slower"
          >◀</button>
          <span style={{ fontSize: 10, color: "var(--snippy-text)", fontVariantNumeric: "tabular-nums", minWidth: 28, textAlign: "center" as const, fontWeight: 600 }}>{playbackRate}×</span>
          <button
            onClick={() => {
              const idx = SPEEDS.indexOf(playbackRate);
              if (idx < SPEEDS.length - 1) onPlaybackRateChange(SPEEDS[idx + 1]);
            }}
            disabled={SPEEDS.indexOf(playbackRate) >= SPEEDS.length - 1}
            style={{ ...btnStyle, fontSize: 9, padding: "2px 5px", opacity: SPEEDS.indexOf(playbackRate) >= SPEEDS.length - 1 ? 0.3 : 1 }}
            title="Faster"
          >▶</button>

          <div className="flex items-center gap-1" style={{ fontSize: 12 }} title={`Volume: ${Math.round(volume * 100)}%`}>
            <span>{volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}</span>
            <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => onVolumeChange(Number(e.target.value))} onWheel={(e) => e.stopPropagation()} style={{ width: 50, accentColor: "var(--snippy-accent)" }} />
          </div>

          <div style={{ width: 1, height: 16, background: "var(--snippy-border)", margin: "0 2px" }} />

          <span style={{ fontSize: 9, color: "var(--snippy-text-secondary)" }}>−</span>
          <input
            type="range"
            min={1}
            max={30}
            step={0.1}
            value={clampedZoom}
            onChange={(e) => {
              const newZoom = Number(e.target.value);
              const center = zoomCenter();
              setZoom(newZoom);
              requestAnimationFrame(() => {
                if (!outerRef.current) return;
                const newCW = Math.max(viewportWidth, viewportWidth * newZoom);
                const newPx = (center / duration) * newCW;
                outerRef.current.scrollLeft = Math.max(0, newPx - outerRef.current.clientWidth / 2);
              });
            }}
            style={{ width: 140, accentColor: "var(--snippy-accent)" }}
            onWheel={(e) => e.stopPropagation()}
          />
          <span style={{ fontSize: 9, color: "var(--snippy-text-secondary)" }}>+</span>
          <span style={{ fontSize: 9, color: "var(--snippy-text)", minWidth: 32, textAlign: "center" as const, fontVariantNumeric: "tabular-nums" }}>{clampedZoom.toFixed(1)}×</span>
          <button onClick={() => { fit(); onFitProp(); }} style={{ ...btnStyle, fontSize: 9, padding: "2px 6px" }}>fit</button>
        </div>

        {/* Scrollable area: ruler + layers */}
        <div
          ref={outerRef}
          className="relative overflow-x-scroll overflow-y-hidden snippy-scrubber-scroll"
          style={{ height: Math.max(RULER_H + lanesH, laneAreaHeight), touchAction: "pan-x", width: "100%", minWidth: 0, maxWidth: "100%" }}
        >
          <div
            ref={contentRef}
            className="relative select-none"
            style={{ width: contentWidth, height: "100%", cursor: dragging === "playhead" ? "grabbing" : "crosshair" }}
            onPointerDown={(e) => {
              const target = e.target as HTMLElement;
              if (target.dataset.handle === "start") return onPointerDown(e, "start");
              if (target.dataset.handle === "end") return onPointerDown(e, "end");
              if (target.dataset.handle === "playhead") return onPointerDown(e, "playhead");
              if (target.dataset.layer) { onLayerSelect(target.dataset.layer); return; }
              onLayerSelect(null);
              onPointerDown(e, "track");
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* Ruler */}
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute flex flex-col items-start pl-1"
                style={{ left: secToPx(t), top: 0, height: RULER_H, pointerEvents: "none", color: "var(--snippy-text-secondary)" }}
              >
                <div style={{ width: 1, height: 10, background: "var(--snippy-border)" }} />
                <div style={{ fontSize: 9, fontVariantNumeric: "tabular-nums", marginTop: 1, fontFamily: "var(--font-geist-mono, ui-monospace)" }}>
                  {fmtTick(t)}
                </div>
              </div>
            ))}

            {/* Lanes */}
            <div style={{ position: "absolute", top: RULER_H, left: 0, right: 0, height: lanesH }}>
              {/* Video lane with waveform */}
              <div
                data-layer="video"
                style={{
                  height: VIDEO_LANE_H, borderBottom: "1px solid var(--snippy-border)",
                  background: selectedLayerId === "video" ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                  cursor: "crosshair", position: "relative", overflow: "hidden",
                }}
              >
                <span style={{ position: "sticky", left: 8, zIndex: 2, fontSize: 9, fontWeight: 600, color: "var(--snippy-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", lineHeight: `${VIDEO_LANE_H}px`, paddingLeft: 4 }}>
                  ▶ Video
                </span>
                {/* Waveform bars — style matches /edit timeline */}
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", gap: 1, padding: "0 2px", overflow: "hidden", pointerEvents: "none" }}>
                  {waveformBars.map((h, i) => (
                    <div key={i} style={{ flex: 1, minWidth: 2, height: h, background: "rgba(160,160,160,0.35)", borderRadius: 1 }} />
                  ))}
                </div>
              </div>

              {/* Captions lane */}
              {hasCaptions && (
                <div
                  data-layer="captions"
                  style={{
                    height: LANE_H, borderBottom: "1px solid var(--snippy-border)",
                    background: selectedLayerId === "captions" ? "rgba(217,119,87,0.1)" : "transparent",
                    cursor: "crosshair", position: "relative",
                  }}
                >
                  <span style={{ position: "sticky", left: 8, zIndex: 2, fontSize: 9, fontWeight: 600, color: "var(--snippy-text-secondary)", lineHeight: `${LANE_H}px`, paddingLeft: 4 }}>
                    T Captions
                  </span>
                  {startSec != null && endSec != null && (
                    <div style={{
                      position: "absolute", left: secToPx(startSec), width: Math.max(2, secToPx(endSec) - secToPx(startSec)),
                      height: LANE_H - 8, top: 4, background: "rgba(217,119,87,0.25)", borderRadius: 4, border: "1px solid rgba(217,119,87,0.5)",
                      pointerEvents: "none",
                    }} />
                  )}
                </div>
              )}

              {/* Overlay lanes — draggable blocks */}
              {overlays.map((ov, i) => {
                const color = ov.bgColor || LANE_COLORS[i % LANE_COLORS.length];
                const blockLeft = secToPx(ov.startSec);
                const blockW = Math.max(6, secToPx(ov.endSec) - secToPx(ov.startSec));
                const handleOverlayDragStart = (edge: "start" | "end" | "move") => (e: React.MouseEvent) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const initX = e.clientX;
                  setOverlayDrag({ id: ov.id, edge, initX, initStart: ov.startSec, initEnd: ov.endSec });
                  const onMove = (ev: MouseEvent) => {
                    const dx = ev.clientX - initX;
                    const dSec = pxToSec(dx);
                    if (edge === "start") {
                      const ns = Math.max(0, Math.min(ov.endSec - 0.1, ov.startSec + dSec));
                      onOverlayTimingChange?.(ov.id, ns, ov.endSec);
                    } else if (edge === "end") {
                      const ne = Math.max(ov.startSec + 0.1, Math.min(duration, ov.endSec + dSec));
                      onOverlayTimingChange?.(ov.id, ov.startSec, ne);
                    } else {
                      const dur = ov.endSec - ov.startSec;
                      let ns = ov.startSec + dSec;
                      if (ns < 0) ns = 0;
                      if (ns + dur > duration) ns = duration - dur;
                      onOverlayTimingChange?.(ov.id, ns, ns + dur);
                    }
                  };
                  const onUp = () => {
                    setOverlayDrag(null);
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                  };
                  document.addEventListener("mousemove", onMove);
                  document.addEventListener("mouseup", onUp);
                };
                return (
                <div
                  key={ov.id}
                  data-layer={ov.id}
                  style={{
                    height: LANE_H, borderBottom: "1px solid var(--snippy-border)",
                    background: selectedLayerId === ov.id ? `${color}15` : "transparent",
                    cursor: "crosshair", position: "relative",
                  }}
                >
                  <span style={{ position: "sticky", left: 8, zIndex: 2, fontSize: 9, fontWeight: 600, color: "var(--snippy-text-secondary)", lineHeight: `${LANE_H}px`, paddingLeft: 4, maxWidth: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>
                    T {ov.text || `overlay ${i + 1}`}
                  </span>
                  {/* Draggable overlay block */}
                  <div
                    style={{
                      position: "absolute", left: blockLeft, width: blockW,
                      height: LANE_H - 8, top: 4,
                      background: `${color}33`, borderRadius: 4, border: `1px solid ${color}66`,
                      display: "flex", alignItems: "center", fontSize: 9, color: "var(--snippy-text-secondary)",
                      overflow: "hidden", whiteSpace: "nowrap", cursor: "grab",
                    }}
                    onMouseDown={handleOverlayDragStart("move")}
                    onClick={(e) => { e.stopPropagation(); onLayerSelect(ov.id); }}
                  >
                    {/* Left edge handle */}
                    <div
                      style={{ width: 6, height: "100%", cursor: "ew-resize", flexShrink: 0, background: `${color}55`, borderRadius: "4px 0 0 4px" }}
                      onMouseDown={handleOverlayDragStart("start")}
                    />
                    <span style={{ flex: 1, paddingLeft: 4, overflow: "hidden", textOverflow: "ellipsis" }}>{ov.text}</span>
                    {/* Right edge handle */}
                    <div
                      style={{ width: 6, height: "100%", cursor: "ew-resize", flexShrink: 0, background: `${color}55`, borderRadius: "0 4px 4px 0" }}
                      onMouseDown={handleOverlayDragStart("end")}
                    />
                  </div>
                </div>
                );
              })}
            </div>

            {/* Selection highlight */}
            {selActive && (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: Math.max(0, secToPx(startSec!)), width: Math.max(0, secToPx(endSec!) - secToPx(startSec!)),
                  top: 0, height: RULER_H + lanesH,
                  background: "var(--snippy-selection)", opacity: 0.4,
                  borderLeft: "3px solid var(--snippy-accent)", borderRight: "3px solid var(--snippy-accent)",
                }}
              />
            )}

            {/* IN handle */}
            {startSec != null && (
              <div
                data-handle="start"
                className="absolute"
                style={{ left: secToPx(startSec) - 10, width: 20, top: 0, height: RULER_H + lanesH, cursor: "ew-resize", zIndex: 3, display: "flex", flexDirection: "column", alignItems: "center" }}
                title={`IN — ${startSec.toFixed(2)}s`}
              >
                <div style={{ width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "8px solid var(--snippy-accent)", pointerEvents: "none" }} />
                <div style={{ width: 4, flex: 1, background: "var(--snippy-accent)", borderRadius: 2, pointerEvents: "none" }} />
              </div>
            )}

            {/* OUT handle */}
            {endSec != null && (
              <div
                data-handle="end"
                className="absolute"
                style={{ left: secToPx(endSec) - 10, width: 20, top: 0, height: RULER_H + lanesH, cursor: "ew-resize", zIndex: 3, display: "flex", flexDirection: "column", alignItems: "center" }}
                title={`OUT — ${endSec.toFixed(2)}s`}
              >
                <div style={{ width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "8px solid var(--snippy-accent)", pointerEvents: "none" }} />
                <div style={{ width: 4, flex: 1, background: "var(--snippy-accent)", borderRadius: 2, pointerEvents: "none" }} />
              </div>
            )}

            {/* Playhead */}
            <div
              data-handle="playhead"
              className="absolute"
              style={{ left: secToPx(playheadSec) - 1, width: 3, top: 0, height: RULER_H + lanesH, background: "#fff", pointerEvents: "none", zIndex: 4, boxShadow: "0 0 4px rgba(0,0,0,0.5)" }}
            />
          </div>
        </div>
      </div>
    );
  }
);
