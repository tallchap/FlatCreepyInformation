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
  overlays?: OverlayInfo[];
  captionCount?: number;
  onStartChange: (sec: number) => void;
  onEndChange: (sec: number) => void;
  onSeek: (sec: number) => void;
}

const LANE_H = 32;
const TICK_H = 28;
const LABEL_W = 80;
const LANE_COLORS = ["#D97757", "#4ECDC4", "#FFE66D", "#A8E6CF", "#FF6B6B"];

export interface SnippyScrubberHandle {
  fit: () => void;
  zoomAround: (sec: number, scale: number) => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 60;

function formatTick(sec: number): string {
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

export const SnippyScrubber = forwardRef<SnippyScrubberHandle, Props>(
  function SnippyScrubber(
    { duration, startSec, endSec, playheadSec, overlays = [], captionCount = 0, onStartChange, onEndChange, onSeek },
    ref
  ) {
    const outerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [viewportWidth, setViewportWidth] = useState(1000);
    const [zoom, setZoom] = useState(1);
    const [, setScrollTick] = useState(0);
    const [dragging, setDragging] = useState<"start" | "end" | "playhead" | null>(null);

    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const contentWidth = Math.max(viewportWidth, viewportWidth * clampedZoom);

    useEffect(() => {
      const el = outerRef.current;
      if (!el) return;
      const ro = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width));
      ro.observe(el);
      setViewportWidth(el.clientWidth);
      const onScroll = () => setScrollTick((n) => n + 1);
      el.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        ro.disconnect();
        el.removeEventListener("scroll", onScroll);
      };
    }, []);

    const pxToSec = useCallback(
      (px: number) => (px / contentWidth) * duration,
      [contentWidth, duration]
    );

    const secToPx = useCallback(
      (sec: number) => (sec / duration) * contentWidth,
      [duration, contentWidth]
    );

    const pointerEventToSec = useCallback(
      (e: { clientX: number }) => {
        if (!contentRef.current) return 0;
        const rect = contentRef.current.getBoundingClientRect();
        return Math.max(0, Math.min(duration, pxToSec(e.clientX - rect.left)));
      },
      [duration, pxToSec]
    );

    const zoomAround = useCallback(
      (anchorSec: number, scale: number) => {
        if (!outerRef.current) return;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, clampedZoom * scale)
        );
        if (newZoom === clampedZoom) return;

        const outerRect = outerRef.current.getBoundingClientRect();
        const prevContentWidth = Math.max(
          viewportWidth,
          viewportWidth * clampedZoom
        );
        const prevAnchorPx = (anchorSec / duration) * prevContentWidth;
        const anchorViewportOffset =
          prevAnchorPx - outerRef.current.scrollLeft;

        setZoom(newZoom);

        // After zoom change, recompute scrollLeft so anchor stays under cursor.
        requestAnimationFrame(() => {
          if (!outerRef.current) return;
          const newContentWidth = Math.max(
            viewportWidth,
            viewportWidth * newZoom
          );
          const newAnchorPx = (anchorSec / duration) * newContentWidth;
          const targetScroll = Math.max(
            0,
            Math.min(
              newContentWidth - outerRect.width,
              newAnchorPx - anchorViewportOffset
            )
          );
          outerRef.current.scrollLeft = targetScroll;
        });
      },
      [clampedZoom, viewportWidth, duration]
    );

    const fit = useCallback(() => {
      setZoom(1);
      if (outerRef.current) outerRef.current.scrollLeft = 0;
    }, []);

    useImperativeHandle(ref, () => ({ fit, zoomAround }), [fit, zoomAround]);

    // Wheel: pinch-zoom (cmd/ctrl + wheel) OR trackpad horizontal scroll is native.
    // Plain wheel = zoom around cursor; Shift+wheel = native horizontal scroll.
    useEffect(() => {
      const el = outerRef.current;
      if (!el) return;
      const handler = (e: WheelEvent) => {
        if (e.shiftKey) return; // let browser scroll horizontally
        // If trackpad sends horizontal deltaX, let it scroll natively
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        const rect = contentRef.current!.getBoundingClientRect();
        const anchorSec = ((e.clientX - rect.left) / contentWidth) * duration;
        const scale = e.deltaY > 0 ? 1 / 1.2 : 1.2;
        zoomAround(Math.max(0, Math.min(duration, anchorSec)), scale);
      };
      el.addEventListener("wheel", handler, { passive: false });
      return () => el.removeEventListener("wheel", handler);
    }, [zoomAround, contentWidth, duration]);

    // Autoscroll to keep playhead visible when it moves outside the view.
    useEffect(() => {
      const el = outerRef.current;
      if (!el) return;
      const playheadPx = secToPx(playheadSec);
      const visibleStart = el.scrollLeft;
      const visibleEnd = visibleStart + el.clientWidth;
      const margin = 40;
      if (playheadPx < visibleStart + margin) {
        el.scrollLeft = Math.max(0, playheadPx - margin);
      } else if (playheadPx > visibleEnd - margin) {
        el.scrollLeft = Math.min(
          contentWidth - el.clientWidth,
          playheadPx - el.clientWidth + margin
        );
      }
    }, [playheadSec, secToPx, contentWidth]);

    const onPointerDown = (
      e: React.PointerEvent<HTMLDivElement>,
      kind: "start" | "end" | "playhead" | "track"
    ) => {
      if (!contentRef.current) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const sec = pointerEventToSec(e);
      if (kind === "track") {
        onSeek(sec);
        setDragging("playhead");
      } else {
        setDragging(kind);
      }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const raw = pointerEventToSec(e);
      const snap = e.shiftKey ? Math.round(raw) : raw;
      const clamped = Math.max(0, Math.min(duration, snap));
      if (dragging === "start") {
        const maxStart = endSec != null ? endSec - 0.1 : duration;
        onStartChange(Math.min(clamped, maxStart));
      } else if (dragging === "end") {
        const minEnd = startSec != null ? startSec + 0.1 : 0;
        onEndChange(Math.max(clamped, minEnd));
      } else if (dragging === "playhead") {
        onSeek(clamped);
      }
    };

    const onPointerUp = () => setDragging(null);

    // Compute ticks for the *visible* portion only (perf).
    const visibleStartSec = outerRef.current
      ? (outerRef.current.scrollLeft / contentWidth) * duration
      : 0;
    const visibleEndSec = outerRef.current
      ? ((outerRef.current.scrollLeft + outerRef.current.clientWidth) /
          contentWidth) *
        duration
      : duration;
    const visibleWindowSec = Math.max(
      0.1,
      visibleEndSec - visibleStartSec || duration
    );
    const stepSec = chooseStepSec(visibleWindowSec, viewportWidth);

    const ticks = useMemo(() => {
      const out: number[] = [];
      const first = Math.ceil(visibleStartSec / stepSec) * stepSec;
      for (let t = first; t <= visibleEndSec + stepSec; t += stepSec) {
        if (t >= 0 && t <= duration) out.push(t);
      }
      return out;
    }, [visibleStartSec, visibleEndSec, stepSec, duration]);

    const selActive =
      startSec != null && endSec != null && endSec > startSec;

    const hasCaptions = captionCount > 0;
    const laneCount = 1 + (hasCaptions ? 1 : 0) + overlays.length;
    const timelineH = laneCount * LANE_H + TICK_H;

    return (
      <div className="w-full">
        <div
          ref={outerRef}
          className="relative overflow-x-scroll overflow-y-hidden snippy-scrubber-scroll"
          style={{
            background: "var(--snippy-card)",
            border: "1px solid var(--snippy-border)",
            borderRadius: 12,
            height: timelineH,
            touchAction: "pan-x",
          }}
        >
          <div
            ref={contentRef}
            className="relative select-none"
            style={{
              width: contentWidth,
              height: "100%",
              cursor: dragging === "playhead" ? "grabbing" : "crosshair",
            }}
            onPointerDown={(e) => {
              const target = e.target as HTMLElement;
              if (target.dataset.handle === "start") return onPointerDown(e, "start");
              if (target.dataset.handle === "end") return onPointerDown(e, "end");
              if (target.dataset.handle === "playhead") return onPointerDown(e, "playhead");
              onPointerDown(e, "track");
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* Layer lanes */}
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: laneCount * LANE_H, pointerEvents: "none" }}>
              {/* Video lane */}
              <div style={{ height: LANE_H, borderBottom: "1px solid var(--snippy-border)", display: "flex", alignItems: "center", paddingLeft: 8, fontSize: 10, color: "var(--snippy-text-secondary)" }}>
                <span style={{ position: "sticky", left: 8, zIndex: 2, background: "var(--snippy-card)", padding: "0 4px", borderRadius: 3, fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>▶ Video</span>
                <div style={{ position: "absolute", left: secToPx(0), width: secToPx(duration) - secToPx(0), height: LANE_H - 1, background: "rgba(255,255,255,0.04)", top: 0 }} />
              </div>
              {/* Captions lane */}
              {hasCaptions && (
                <div style={{ height: LANE_H, borderBottom: "1px solid var(--snippy-border)", position: "relative" }}>
                  <span style={{ position: "sticky", left: 8, zIndex: 2, background: "var(--snippy-card)", padding: "0 4px", borderRadius: 3, fontSize: 9, fontWeight: 600, color: "var(--snippy-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", display: "inline-block", marginTop: 8 }}>T Captions</span>
                  {startSec != null && endSec != null && (
                    <div style={{ position: "absolute", left: secToPx(startSec), width: Math.max(2, secToPx(endSec) - secToPx(startSec)), height: LANE_H - 8, top: 4, background: "rgba(217,119,87,0.3)", borderRadius: 4, border: "1px solid rgba(217,119,87,0.5)" }} />
                  )}
                </div>
              )}
              {/* Overlay lanes */}
              {overlays.map((ov, i) => (
                <div key={ov.id} style={{ height: LANE_H, borderBottom: "1px solid var(--snippy-border)", position: "relative" }}>
                  <span style={{ position: "sticky", left: 8, zIndex: 2, background: "var(--snippy-card)", padding: "0 4px", borderRadius: 3, fontSize: 9, fontWeight: 600, color: "var(--snippy-text-secondary)", display: "inline-block", marginTop: 8, maxWidth: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>T {ov.text || `overlay ${i + 1}`}</span>
                  <div style={{
                    position: "absolute",
                    left: secToPx(ov.startSec),
                    width: Math.max(2, secToPx(ov.endSec) - secToPx(ov.startSec)),
                    height: LANE_H - 8,
                    top: 4,
                    background: `${ov.bgColor || LANE_COLORS[i % LANE_COLORS.length]}44`,
                    borderRadius: 4,
                    border: `1px solid ${ov.bgColor || LANE_COLORS[i % LANE_COLORS.length]}88`,
                    display: "flex",
                    alignItems: "center",
                    paddingLeft: 6,
                    fontSize: 9,
                    color: "var(--snippy-text-secondary)",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                  }}>
                    {ov.text}
                  </div>
                </div>
              ))}
            </div>

            {/* Tick marks — positioned below lanes */}
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute flex flex-col items-start pl-1"
                style={{
                  left: secToPx(t),
                  top: laneCount * LANE_H,
                  height: TICK_H,
                  pointerEvents: "none",
                  color: "var(--snippy-text-secondary)",
                }}
              >
                <div
                  style={{
                    width: 1,
                    height: 12,
                    background: "var(--snippy-border)",
                  }}
                />
                <div
                  style={{
                    fontSize: 10,
                    fontVariantNumeric: "tabular-nums",
                    marginTop: 2,
                    fontFamily: "var(--font-geist-mono, ui-monospace)",
                  }}
                >
                  {formatTick(t)}
                </div>
              </div>
            ))}

            {selActive && (
              <div
                className="absolute top-1 bottom-1 pointer-events-none"
                style={{
                  left: Math.max(0, secToPx(startSec!)),
                  width: Math.max(
                    0,
                    secToPx(endSec!) - secToPx(startSec!)
                  ),
                  background: "var(--snippy-selection)",
                  borderRadius: 6,
                  borderLeft: "2px solid var(--snippy-accent)",
                  borderRight: "2px solid var(--snippy-accent)",
                }}
              />
            )}

            {startSec != null && (
              <div
                data-handle="start"
                className="absolute top-0 bottom-0 flex items-center"
                style={{
                  left: secToPx(startSec) - 9,
                  width: 18,
                  cursor: "ew-resize",
                  zIndex: 3,
                }}
                title={`IN — ${startSec.toFixed(2)}s`}
              >
                <div
                  style={{
                    width: 4,
                    height: "75%",
                    background: "var(--snippy-accent)",
                    borderRadius: 2,
                    pointerEvents: "none",
                  }}
                />
              </div>
            )}

            {endSec != null && (
              <div
                data-handle="end"
                className="absolute top-0 bottom-0 flex items-center justify-end"
                style={{
                  left: secToPx(endSec) - 9,
                  width: 18,
                  cursor: "ew-resize",
                  zIndex: 3,
                }}
                title={`OUT — ${endSec.toFixed(2)}s`}
              >
                <div
                  style={{
                    width: 4,
                    height: "75%",
                    background: "var(--snippy-accent)",
                    borderRadius: 2,
                    pointerEvents: "none",
                  }}
                />
              </div>
            )}

            <div
              data-handle="playhead"
              className="absolute top-0 bottom-0"
              style={{
                left: secToPx(playheadSec) - 1,
                width: 2,
                background: "var(--snippy-text)",
                pointerEvents: "none",
                zIndex: 4,
              }}
            />
          </div>
        </div>

        <div
          className="flex items-center justify-between mt-1 text-[10px] snippy-label"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          <span>0:00</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                const center =
                  outerRef.current
                    ? ((outerRef.current.scrollLeft +
                        outerRef.current.clientWidth / 2) /
                        contentWidth) *
                      duration
                    : duration / 2;
                zoomAround(center, 1.5);
              }}
              className="px-2 py-0.5 rounded"
              style={{
                border: "1px solid var(--snippy-border)",
                color: "var(--snippy-text)",
                textTransform: "none",
                letterSpacing: 0,
                fontSize: 12,
                lineHeight: 1,
              }}
              title="Zoom in"
            >
              +
            </button>
            <span style={{ color: "var(--snippy-text)", fontSize: 10 }}>
              {clampedZoom.toFixed(1)}×
            </span>
            <button
              onClick={() => {
                const center =
                  outerRef.current
                    ? ((outerRef.current.scrollLeft +
                        outerRef.current.clientWidth / 2) /
                        contentWidth) *
                      duration
                    : duration / 2;
                zoomAround(center, 1 / 1.5);
              }}
              className="px-2 py-0.5 rounded"
              style={{
                border: "1px solid var(--snippy-border)",
                color: "var(--snippy-text)",
                textTransform: "none",
                letterSpacing: 0,
                fontSize: 12,
                lineHeight: 1,
              }}
              title="Zoom out"
            >
              −
            </button>
            <button
              onClick={fit}
              className="px-2 py-0.5 rounded"
              style={{
                border: "1px solid var(--snippy-border)",
                color: "var(--snippy-text-secondary)",
                textTransform: "none",
                letterSpacing: 0,
                fontSize: 10,
                lineHeight: 1,
              }}
              title="Fit full duration"
            >
              fit
            </button>
            <span style={{ fontSize: 9, opacity: 0.7 }}>
              wheel zooms · drag-scroll or shift+wheel pans
            </span>
          </div>
          <span>{formatTick(duration)}</span>
        </div>
      </div>
    );
  }
);
