"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SnippyPlayer, type SnippyPlayerHandle } from "./snippy-player";
import { SnippyTimeline, type SnippyTimelineHandle } from "./snippy-timeline";
import { SnippyExportBar } from "./snippy-export-bar";
import { SnippyBunnyPicker, type BunnyItem } from "./snippy-bunny-picker";
import { SnippyOverlayList } from "./snippy-overlay-list";
import {
  DEFAULT_CAPTION_STYLE,
  type OverlaySettings,
  type WordTimestamp,
  type CaptionStyle,
} from "./types";

const MAX_CLIP_SEC = 10 * 60;

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function rebaseWordsToClip(
  words: WordTimestamp[],
  inSec: number,
  outSec: number
): WordTimestamp[] {
  if (outSec <= inSec) return [];
  return words
    .filter((w) => w.end > inSec && w.start < outSec)
    .map((w) => ({
      text: w.text,
      start: Math.max(0, w.start - inSec),
      end: Math.max(0, Math.min(outSec, w.end) - inSec),
    }))
    .filter((w) => w.end > w.start && w.text.trim().length > 0);
}

interface SnippyEditorProps {
  clipVideoGuid?: string;
  clipInSec?: number;
  clipOutSec?: number;
  autoTranscribe?: boolean;
  hideMarks?: boolean;
}

export function SnippyEditor({
  clipVideoGuid,
  clipInSec,
  clipOutSec,
  autoTranscribe = false,
  hideMarks = false,
}: SnippyEditorProps = {}) {
  const [bunnyVideo, setBunnyVideo] = useState<BunnyItem | null>(null);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const [totalDuration, setTotalDuration] = useState(0);
  const [startSec, setStartSec] = useState<number | null>(null);
  const [endSec, setEndSec] = useState<number | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [overlays, setOverlays] = useState<OverlaySettings[]>([]);
  const [positioningId, setPositioningId] = useState<string | null>(null);
  const [positioningCaptions, setPositioningCaptions] = useState(false);
  const [sourceCaptions, setSourceCaptions] = useState<WordTimestamp[]>([]);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeStatus, setTranscribeStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [resolution, setResolution] = useState<720 | 1080>(1080);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const debugLogsRef = useRef<HTMLPreElement>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [captionStyleOpen, setCaptionStyleOpen] = useState(false);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [transcriptWidth, setTranscriptWidth] = useState(260);
  const [timelineHeight, setTimelineHeight] = useState(160);
  const [rightPanelWidth, setRightPanelWidth] = useState(320);

  const playerRef = useRef<SnippyPlayerHandle>(null);
  const playerWrapRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<SnippyTimelineHandle>(null);

  const videoUrl = bunnyVideo
    ? `/api/bunny-proxy?src=${encodeURIComponent(bunnyVideo.mp4Url || "")}`
    : "";
  const selectionValid =
    startSec != null && endSec != null && endSec > startSec;
  const clipDurationSec = selectionValid ? endSec! - startSec! : 0;
  const clipTooLong = clipDurationSec > MAX_CLIP_SEC;
  const positioningOverlay = overlays.find((o) => o.id === positioningId) || null;

  const inputFocused = () => {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
  };

  const markIn = useCallback(() => {
    if (inputFocused()) return;
    const sec = playerRef.current?.getCurrentTime() ?? playheadSec;
    const clamped =
      endSec != null && sec >= endSec ? endSec - 0.1 : Math.max(0, sec);
    setStartSec(clamped);
    playerRef.current?.seekTo(clamped);
  }, [playheadSec, endSec]);

  const markOut = useCallback(() => {
    if (inputFocused()) return;
    const sec = playerRef.current?.getCurrentTime() ?? playheadSec;
    const clamped =
      startSec != null && sec <= startSec
        ? startSec + 0.1
        : Math.min(totalDuration, sec);
    setEndSec(clamped);
  }, [playheadSec, startSec, totalDuration]);

  const jumpIn = useCallback(() => {
    if (startSec == null) return;
    playerRef.current?.seekTo(startSec);
  }, [startSec]);

  const jumpOut = useCallback(() => {
    if (endSec == null) return;
    playerRef.current?.seekTo(endSec);
  }, [endSec]);

  const playSelection = useCallback(() => {
    if (!selectionValid) return;
    playerRef.current?.playRange(startSec!, endSec!);
  }, [selectionValid, startSec, endSec]);

  const fitScrubber = useCallback(() => timelineRef.current?.fit(), []);
  const clearSelection = useCallback(() => {
    setStartSec(null);
    setEndSec(null);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (inputFocused()) return;
      if (e.code === "Space") {
        e.preventDefault();
        playerRef.current?.toggle();
      } else if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        markIn();
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        markOut();
      } else if (e.key === "[") {
        e.preventDefault();
        jumpIn();
      } else if (e.key === "]") {
        e.preventDefault();
        jumpOut();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const delta = e.shiftKey ? 1 : 1 / 30;
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        const now = playerRef.current?.getCurrentTime() ?? playheadSec;
        playerRef.current?.seekTo(
          Math.max(0, Math.min(totalDuration, now + dir * delta))
        );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [markIn, markOut, jumpIn, jumpOut, playheadSec, totalDuration]);

  const handlePickBunny = useCallback((v: BunnyItem) => {
    setBunnyVideo(v);
    setSourceCollapsed(true);
    setTotalDuration(v.length || 0);
    setStartSec(null);
    setEndSec(null);
    setPlayheadSec(0);
    setOverlays([]);
    setSourceCaptions([]);
    setTranscribeStatus("");
    setExportStatus("");
  }, []);

  // Auto-load video + set clip range when coming from clip selector (Step 1)
  useEffect(() => {
    if (!clipVideoGuid) return;
    fetch(`/api/bunny/videos?itemsPerPage=100`)
      .then((r) => r.json())
      .then((data) => {
        const video = (data.items || []).find((v: BunnyItem) => v.guid === clipVideoGuid);
        if (video) {
          handlePickBunny(video);
          if (clipInSec != null && clipOutSec != null && clipOutSec > clipInSec) {
            setTimeout(() => {
              setStartSec(clipInSec);
              setEndSec(clipOutSec);
              setPlayheadSec(clipInSec);
            }, 500);
          }
        }
      })
      .catch(() => {});
  }, [clipVideoGuid, clipInSec, clipOutSec, handlePickBunny]);

  // Auto-transcribe when clip is loaded from Step 1
  useEffect(() => {
    if (!autoTranscribe || !bunnyVideo || !selectionValid || sourceCaptions.length > 0) return;
    const timer = setTimeout(() => handleTranscribe(), 1500);
    return () => clearTimeout(timer);
  }, [autoTranscribe, bunnyVideo, selectionValid, sourceCaptions.length]);

  const handleDurationDetected = useCallback((d: number) => {
    if (!d || !isFinite(d)) return;
    setTotalDuration((prev) => (Math.abs(prev - d) > 0.5 ? d : prev));
  }, []);

  useEffect(() => {
    if (!selectionValid) return;
    const clipDur = endSec! - startSec!;
    setOverlays((prev) =>
      prev.map((o) => ({
        ...o,
        startSec: Math.max(0, Math.min(clipDur - 0.01, o.startSec)),
        endSec: Math.max(
          Math.max(0, Math.min(clipDur - 0.01, o.startSec)) + 0.1,
          Math.min(clipDur, o.endSec)
        ),
      }))
    );
  }, [selectionValid, startSec, endSec]);

  const handleTranscribe = async () => {
    if (!bunnyVideo?.mp4Url || transcribing) return;
    setTranscribing(true);
    const hasRange = selectionValid;
    setTranscribeStatus(
      hasRange
        ? `Transcribing ${clipDurationSec.toFixed(0)}s clip…`
        : "Transcribing full video…"
    );
    try {
      const t0 = Date.now();
      const res = await fetch("/api/snippy-transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: bunnyVideo.mp4Url,
          ...(hasRange
            ? { startSec: startSec!, endSec: endSec! }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body.slice(0, 300));
      }
      const data = (await res.json()) as {
        words: WordTimestamp[];
        sourceWordCount: number;
        provider?: string;
      };
      setSourceCaptions((prev) => {
        if (!hasRange) return data.words;
        // Merge: replace words inside the range, keep words outside
        const kept = prev.filter(
          (w) => w.end <= startSec! || w.start >= endSec!
        );
        const merged = [...kept, ...data.words].sort(
          (a, b) => a.start - b.start
        );
        return merged;
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const providerSuffix = data.provider ? ` via ${data.provider}` : "";
      setTranscribeStatus(
        `Got ${data.sourceWordCount} words${providerSuffix} in ${elapsed}s${hasRange ? " (clip range)" : ""}.`
      );
      setTimeout(() => setTranscribeStatus(""), 6000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transcribe failed";
      setTranscribeStatus(`Error: ${msg}`);
    } finally {
      setTranscribing(false);
    }
  };

  const clipCaptions = useMemo(
    () =>
      selectionValid ? rebaseWordsToClip(sourceCaptions, startSec!, endSec!) : [],
    [sourceCaptions, startSec, endSec, selectionValid]
  );

  const handleAddOverlay = () => {
    if (!selectionValid) {
      setTranscribeStatus("Mark IN/OUT first — overlays attach to a clip.");
      setTimeout(() => setTranscribeStatus(""), 3000);
      return;
    }
    const newOverlay: OverlaySettings = {
      id: genId(),
      text: "New overlay",
      xPct: 0.05,
      yPct: 0.12,
      fontSize: 64,
      fontFamily: "Montserrat",
      color: "#ffffff",
      opacity: 100,
      bgBox: true,
      bgColor: "#1d1917",
      bgOpacity: 80,
      startSec: 0,
      endSec: clipDurationSec,
    };
    setOverlays((prev) => [...prev, newOverlay]);
    setPositioningId(newOverlay.id);
    // Seek to the overlay's first visible frame so user sees it immediately.
    if (startSec != null) playerRef.current?.seekTo(startSec);
  };

  const handleRemoveOverlay = (id: string) => {
    setOverlays((prev) => prev.filter((o) => o.id !== id));
    if (positioningId === id) setPositioningId(null);
  };
  const handleOverlayChange = (id: string, patch: Partial<OverlaySettings>) =>
    setOverlays((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));

  const appendLog = (msg: string) => {
    setDebugLogs((prev) => [...prev, `[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ${msg}`]);
    setTimeout(() => debugLogsRef.current?.scrollTo(0, debugLogsRef.current.scrollHeight), 50);
  };

  const handleExport = async () => {
    if (!bunnyVideo?.mp4Url || !selectionValid || clipTooLong || exporting) return;
    setExporting(true);
    setExportStatus("Rendering… 0%");
    setDebugLogs((prev) => prev.length > 0 ? [...prev, "", "─".repeat(40), ""] : []);
    setDebugOpen(true);

    const body = {
      videoUrl: bunnyVideo.mp4Url,
      startSec: startSec!,
      endSec: endSec!,
      overlays,
      captions: captionsEnabled ? clipCaptions : [],
      captionStyle,
      filenameHint: `snippy-${bunnyVideo.guid.slice(0, 8)}-${Math.round(
        startSec!
      )}-${Math.round(endSec!)}`,
      resolution,
    };

    appendLog(`Export started: ${clipDurationSec.toFixed(1)}s @ ${resolution}p`);

    try {
      const t0 = Date.now();
      const resp = await fetch("/api/snippy-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        let msg = "Render failed";
        try {
          msg = JSON.parse(errBody).error || msg;
        } catch {}
        throw new Error(msg);
      }

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      let downloadUrl = "";

      if (reader) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const dataMatch = line.match(/^data:\s*(.+)/);
            if (!dataMatch) continue;
            try {
              const event = JSON.parse(dataMatch[1]);
              if (event.log) appendLog(event.log);
              if (event.error) throw new Error(event.error);
              if (event.progress != null) {
                setExportStatus(`Rendering… ${event.progress}%`);
              }
              if (event.done && event.url) {
                downloadUrl = event.url;
              }
            } catch (e) {
              if (e instanceof Error && e.message !== "Unexpected end of JSON input") throw e;
            }
          }
        }
      }

      if (!downloadUrl) throw new Error("Render completed but no download URL received");

      setExportStatus("Downloading…");
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `${body.filenameHint}.mp4`;
      a.click();

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      setExportStatus(`Done · ${elapsed}s`);
      setTimeout(() => setExportStatus(""), 8000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Render failed";
      setExportStatus(`Error: ${msg}`);
    } finally {
      setExporting(false);
    }
  };

  const sourceWordCount = sourceCaptions.length;
  const clipWordCount = clipCaptions.length;

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1
            className="text-3xl font-semibold tracking-tight"
            style={{ color: "var(--snippy-text)" }}
          >
            Snippy
          </h1>
          <p
            className="text-sm mt-1"
            style={{ color: "var(--snippy-text-secondary)" }}
          >
            Bunny Stream → mark IN/OUT → karaoke captions → MP4
          </p>
        </div>
        <div className="snippy-label" style={{ fontSize: 11 }}>
          I / O · [ · ] · ← → · Space
        </div>
      </header>

      <SnippyBunnyPicker
        onSelect={handlePickBunny}
        selectedGuid={bunnyVideo?.guid || null}
        collapsed={sourceCollapsed && !!bunnyVideo}
        selectedVideo={bunnyVideo}
        onExpand={() => setSourceCollapsed(false)}
      />

      {bunnyVideo && videoUrl && (
        <>
        {/* Top area: Transcript | resize | Video | resize | Right panel */}
        <div className="flex" style={{ minHeight: 200, overflow: "hidden" }}>
          {/* LEFT — Transcript word list only */}
          <div
            className="snippy-card overflow-y-auto flex-shrink-0"
            style={{ width: transcriptWidth, maxHeight: "60vh" }}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold" style={{ color: "var(--snippy-text)" }}>Transcript</h3>
              <button
                onClick={handleTranscribe}
                disabled={transcribing}
                className="text-[10px] px-2 py-0.5 rounded"
                style={{
                  background: "var(--snippy-accent)",
                  color: "#fff",
                  opacity: transcribing ? 0.5 : 1,
                  cursor: transcribing ? "not-allowed" : "pointer",
                }}
              >
                {transcribing ? "…" : sourceWordCount ? "Re-transcribe" : "Transcribe"}
              </button>
            </div>
            {transcribeStatus && (
              <div className="mb-2 px-2 py-1 rounded" style={{ fontSize: 10, color: transcribeStatus.startsWith("Error") ? "#b94a2e" : "var(--snippy-text-secondary)", background: transcribeStatus.startsWith("Error") ? "rgba(185,74,46,0.08)" : "var(--snippy-canvas)", border: `1px solid ${transcribeStatus.startsWith("Error") ? "rgba(185,74,46,0.3)" : "var(--snippy-border)"}` }}>
                {transcribeStatus}
              </div>
            )}
            {sourceCaptions.length > 0 ? (
              <CaptionWordList
                sourceCaptions={sourceCaptions}
                startSec={startSec}
                endSec={endSec}
                playheadSec={playheadSec}
                onWordEdit={(index, text) =>
                  setSourceCaptions((prev) =>
                    prev.map((w, i) => (i === index ? { ...w, text } : w))
                  )
                }
                onWordDelete={(index) =>
                  setSourceCaptions((prev) => prev.filter((_, i) => i !== index))
                }
                onWordSeek={(sourceSec) =>
                  playerRef.current?.seekTo(sourceSec)
                }
              />
            ) : (
              <div
                className="text-center py-8"
                style={{ fontSize: 11, color: "var(--snippy-text-secondary)", opacity: 0.6 }}
              >
                No transcript yet. Mark IN/OUT and transcribe.
              </div>
            )}
          </div>

          {/* Vertical resize handle (transcript width) */}
          <div
            style={{
              width: 12,
              cursor: "col-resize",
              background: "rgba(0,0,0,0.06)",
              flexShrink: 0,
              transition: "background 0.15s",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column" as const,
              gap: 2,
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = transcriptWidth;
              const onMove = (ev: MouseEvent) => {
                setTranscriptWidth(Math.max(180, Math.min(500, startW + ev.clientX - startX)));
              };
              const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(217,119,87,0.25)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.06)"; }}
          >
            <div style={{ width: 4, height: 4, borderRadius: "50%", background: "rgba(0,0,0,0.2)" }} />
            <div style={{ width: 4, height: 4, borderRadius: "50%", background: "rgba(0,0,0,0.2)" }} />
            <div style={{ width: 4, height: 4, borderRadius: "50%", background: "rgba(0,0,0,0.2)" }} />
          </div>

          {/* CENTER — Video Player */}
          <div className="flex-1" style={{ minWidth: 0, overflow: "hidden" }}>
            <div ref={playerWrapRef} className="relative" style={{ width: "100%", overflow: "hidden" }}>
              <SnippyPlayer
                ref={playerRef}
                videoUrl={videoUrl}
                totalDuration={totalDuration || bunnyVideo.length || 60}
                inSec={startSec}
                outSec={endSec}
                overlays={overlays}
                sourceCaptions={captionsEnabled ? sourceCaptions : []}
                captionStyle={captionStyle}
                playbackRate={playbackRate}
                onTimeUpdate={setPlayheadSec}
                onPlayingChange={setIsPlaying}
                onDurationDetected={handleDurationDetected}
              />
              {positioningOverlay && (
                <PositioningLayer
                  label={`overlay "${positioningOverlay.text || "overlay"}"`}
                  x={positioningOverlay.xPct}
                  y={positioningOverlay.yPct}
                  wrapRef={playerWrapRef}
                  onChange={(x, y) =>
                    handleOverlayChange(positioningOverlay.id, { xPct: x, yPct: y })
                  }
                  onDone={() => setPositioningId(null)}
                />
              )}
              {positioningCaptions && !positioningOverlay && (
                <PositioningLayer
                  label="captions"
                  x={captionStyle.xPct}
                  y={captionStyle.yPct}
                  wrapRef={playerWrapRef}
                  onChange={(x, y) =>
                    setCaptionStyle((prev) => ({ ...prev, xPct: x, yPct: y }))
                  }
                  onDone={() => setPositioningCaptions(false)}
                />
              )}
            </div>
          </div>

          {/* Vertical resize handle (right panel) */}
          <div
            style={{
              width: 12,
              cursor: "col-resize",
              background: "rgba(0,0,0,0.06)",
              flexShrink: 0,
              transition: "background 0.15s",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column" as const,
              gap: 2,
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = rightPanelWidth;
              const onMove = (ev: MouseEvent) => {
                setRightPanelWidth(Math.max(260, Math.min(500, startW - (ev.clientX - startX))));
              };
              const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(217,119,87,0.25)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.06)"; }}
          >
            <div style={{ width: 4, height: 4, borderRadius: "50%", background: "rgba(0,0,0,0.2)" }} />
            <div style={{ width: 4, height: 4, borderRadius: "50%", background: "rgba(0,0,0,0.2)" }} />
            <div style={{ width: 4, height: 4, borderRadius: "50%", background: "rgba(0,0,0,0.2)" }} />
          </div>

          {/* RIGHT — Overlays + Captions styling + Export */}
          <div className="flex-shrink-0 space-y-3 overflow-y-auto" style={{ width: rightPanelWidth, maxHeight: "60vh" }}>
            <SnippyOverlayList
              overlays={overlays}
              clipDurationSec={clipDurationSec || 10}
              positioningId={positioningId}
              onAdd={handleAddOverlay}
              onRemove={handleRemoveOverlay}
              onChange={handleOverlayChange}
              onStartPositioning={setPositioningId}
            />
            <CaptionsPanel
              sourceCaptions={sourceCaptions}
              sourceWordCount={sourceWordCount}
              clipWordCount={clipWordCount}
              startSec={startSec}
              endSec={endSec}
              playheadSec={playheadSec}
              captionsEnabled={captionsEnabled}
              captionStyle={captionStyle}
              positioningCaptions={positioningCaptions}
              onToggle={setCaptionsEnabled}
              onStyleChange={(patch) =>
                setCaptionStyle((prev) => ({ ...prev, ...patch }))
              }
              onStartPositioning={() =>
                setPositioningCaptions((v) => !v)
              }
              onTranscribe={handleTranscribe}
              transcribing={transcribing}
              status={transcribeStatus}
              hasSelection={selectionValid}
              onWordEdit={(index, text) =>
                setSourceCaptions((prev) =>
                  prev.map((w, i) => (i === index ? { ...w, text } : w))
                )
              }
              onWordDelete={(index) =>
                setSourceCaptions((prev) => prev.filter((_, i) => i !== index))
              }
              onWordSeek={(sourceSec) =>
                playerRef.current?.seekTo(sourceSec)
              }
              styleOpen={captionStyleOpen}
              onStyleToggle={() => setCaptionStyleOpen((v) => !v)}
              hideWordList
            />
            <SnippyExportBar
              selectionValid={selectionValid && !clipTooLong}
              clipDurationSec={clipDurationSec}
              exporting={exporting}
              exportStatus={
                clipTooLong
                  ? `Clip exceeds ${MAX_CLIP_SEC / 60}-min limit`
                  : exportStatus
              }
              resolution={resolution}
              onResolutionChange={setResolution}
              onExport={handleExport}
            />
          </div>
        </div>


        {/* Timeline — full width below */}
        <div>
          <SnippyTimeline
            ref={timelineRef}
            duration={hideMarks && clipDurationSec > 0 ? clipDurationSec : (totalDuration || bunnyVideo.length || 60)}
            startSec={hideMarks ? null : startSec}
            endSec={hideMarks ? null : endSec}
            playheadSec={hideMarks && startSec != null ? playheadSec - startSec : playheadSec}
            isPlaying={isPlaying}
            overlays={overlays}
            captionCount={sourceCaptions.length}
            selectedLayerId={selectedLayerId}
            playbackRate={playbackRate}
            volume={volume}
            laneAreaHeight={timelineHeight}
            onStartChange={(s) => setStartSec(endSec != null && s >= endSec ? endSec - 0.1 : s)}
            onEndChange={(s) => setEndSec(startSec != null && s <= startSec ? startSec + 0.1 : s)}
            onSeek={(s) => {
              const abs = hideMarks && startSec != null ? s + startSec : s;
              setPlayheadSec(abs);
              playerRef.current?.seekTo(abs);
            }}
            onMarkIn={markIn}
            onMarkOut={markOut}
            onTogglePlay={() => playerRef.current?.toggle()}
            onPlaybackRateChange={setPlaybackRate}
            onVolumeChange={(v) => { setVolume(v); playerRef.current?.setVolume(v); }}
            onLayerSelect={setSelectedLayerId}
            onFit={() => {}}
            hideMarks={hideMarks}
            onOverlayTimingChange={(id, s, e) => handleOverlayChange(id, { startSec: s, endSec: e })}
            videoUrl={videoUrl}
          />
        </div>
        </>
      )}

      {bunnyVideo && videoUrl && (
        <>

          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => setDebugOpen((v) => !v)}
              className="snippy-btn-ghost text-xs"
            >
              {debugOpen ? "Hide debug" : "Show debug"}
            </button>
          </div>

          {debugOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <pre
                className="text-[11px] p-3 rounded-xl overflow-auto max-h-64"
                style={{
                  background: "#0d0d0d",
                  color: "#a1e8a1",
                  fontFamily: "var(--font-geist-mono, ui-monospace)",
                }}
              >
                {JSON.stringify(
                  {
                    bunnyVideo: bunnyVideo
                      ? { guid: bunnyVideo.guid, title: bunnyVideo.title }
                      : null,
                    totalDuration,
                    startSec,
                    endSec,
                    playheadSec,
                    clipDurationSec,
                    isPlaying,
                    overlays: overlays.length,
                    sourceWordCount,
                    clipWordCount,
                    exporting,
                    exportStatus,
                  },
                  null,
                  2
                )}
              </pre>
              {debugLogs.length > 0 && (
                <div style={{ position: "relative" }}>
                  <button
                    onClick={() => navigator.clipboard.writeText(debugLogs.join("\n"))}
                    className="text-[10px] px-2 py-1 rounded"
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 8,
                      background: "rgba(255,255,255,0.15)",
                      color: "#a1e8a1",
                      border: "none",
                      cursor: "pointer",
                      zIndex: 1,
                    }}
                  >
                    Copy logs
                  </button>
                  <pre
                    ref={debugLogsRef}
                    className="text-[11px] p-3 rounded-xl overflow-auto max-h-64"
                    style={{
                      background: "#0d0d0d",
                      color: "#d4d4d4",
                      fontFamily: "var(--font-geist-mono, ui-monospace)",
                      margin: 0,
                    }}
                  >
                    {debugLogs.join("\n")}
                  </pre>
                </div>
              )}
            </div>
          )}

        </>
      )}
    </div>
  );
}

function PositioningLayer({
  label,
  x,
  y,
  wrapRef,
  onChange,
  onDone,
}: {
  label: string;
  x: number;
  y: number;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onChange: (x: number, y: number) => void;
  onDone: () => void;
}) {
  const dragRef = useRef(false);

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    onChange(nx, ny);
  };

  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = true;
    move(e);
  };

  const end = () => {
    dragRef.current = false;
  };

  return (
    <div
      className="absolute inset-0 z-10"
      style={{
        cursor: "crosshair",
        background: "rgba(217,119,87,0.05)",
      }}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div
        className="absolute top-2 left-2 px-2 py-1 rounded-md text-[11px] font-medium z-20"
        style={{
          background: "var(--snippy-accent)",
          color: "#fff",
        }}
      >
        Drag to position {label} · ({Math.round(x * 100)}%, {Math.round(y * 100)}%)
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDone();
          }}
          className="ml-2 underline"
        >
          done
        </button>
      </div>
    </div>
  );
}

function CaptionsPanel({
  sourceCaptions,
  sourceWordCount,
  clipWordCount,
  startSec,
  endSec,
  playheadSec,
  captionsEnabled,
  captionStyle,
  positioningCaptions,
  onToggle,
  onStyleChange,
  onStartPositioning,
  onTranscribe,
  transcribing,
  status,
  hasSelection,
  onWordEdit,
  onWordDelete,
  onWordSeek,
  styleOpen,
  onStyleToggle,
  hideWordList = false,
  hideHeader = false,
}: {
  sourceCaptions: WordTimestamp[];
  sourceWordCount: number;
  clipWordCount: number;
  startSec: number | null;
  endSec: number | null;
  playheadSec: number;
  captionsEnabled: boolean;
  captionStyle: CaptionStyle;
  positioningCaptions: boolean;
  onToggle: (b: boolean) => void;
  onStyleChange: (patch: Partial<CaptionStyle>) => void;
  onStartPositioning: () => void;
  onTranscribe: () => void;
  transcribing: boolean;
  status: string;
  hasSelection: boolean;
  onWordEdit: (sourceIndex: number, text: string) => void;
  onWordDelete: (sourceIndex: number) => void;
  onWordSeek: (sourceSec: number) => void;
  styleOpen: boolean;
  onStyleToggle: () => void;
  hideWordList?: boolean;
  hideHeader?: boolean;
}) {
  const isError = status.startsWith("Error");

  return (
    <div className={hideHeader ? "" : "snippy-card"}>
      {!hideHeader && <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3
            className="text-sm font-semibold"
            style={{ color: "var(--snippy-text)", cursor: "pointer" }}
            onClick={onStyleToggle}
          >
            {styleOpen ? "▼" : "▶"} Captions
          </h3>
          <label
            className="flex items-center gap-1 cursor-pointer"
            style={{ fontSize: 10, color: "var(--snippy-text-secondary)" }}
          >
            <input
              type="checkbox"
              checked={captionsEnabled}
              onChange={(e) => onToggle(e.target.checked)}
              className="scale-90"
            />
            karaoke
          </label>
          {sourceWordCount > 0 && (
            <span
              className="snippy-label"
              style={{ fontSize: 9, letterSpacing: 0, textTransform: "none" }}
            >
              · {sourceWordCount}{hasSelection ? ` · ${clipWordCount} in clip` : " words"}
            </span>
          )}
        </div>
        <button
          onClick={onTranscribe}
          disabled={transcribing}
          className="text-[11px] px-2.5 py-1 rounded"
          style={{
            background: "var(--snippy-accent)",
            color: "#fff",
            opacity: transcribing ? 0.5 : 1,
          }}
          title="Transcribe the full Bunny video (cached)"
        >
          {transcribing
            ? "…"
            : sourceWordCount
            ? "Re-transcribe"
            : "Transcribe"}
        </button>
      </div>}

      {status && !hideHeader && (
        <div
          className="mb-2 px-2 py-1 rounded"
          style={{
            fontSize: 11,
            color: isError ? "#b94a2e" : "var(--snippy-text-secondary)",
            background: isError
              ? "rgba(185,74,46,0.08)"
              : "var(--snippy-canvas)",
            border: `1px solid ${
              isError ? "rgba(185,74,46,0.3)" : "var(--snippy-border)"
            }`,
          }}
        >
          {status}
        </div>
      )}

      {styleOpen && (<>
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={onStartPositioning}
          className="text-[11px] px-2 py-1 rounded"
          style={{
            border: `1px solid ${
              positioningCaptions ? "var(--snippy-accent)" : "var(--snippy-border)"
            }`,
            color: positioningCaptions ? "var(--snippy-accent)" : "var(--snippy-text-secondary)",
            background: positioningCaptions ? "var(--snippy-selection)" : "transparent",
            fontWeight: positioningCaptions ? 600 : 400,
          }}
          title="Drag on preview to position"
        >
          {positioningCaptions ? "positioning…" : "position"}
        </button>
        <div
          className="flex-1 font-mono"
          style={{
            fontSize: 10,
            color: "var(--snippy-text-secondary)",
          }}
        >
          {Math.round(captionStyle.xPct * 100)},
          {Math.round(captionStyle.yPct * 100)}
          <span style={{ color: "var(--snippy-border)" }}> · </span>
          w{Math.round(captionStyle.widthPct * 100)}
        </div>
        <select
          value={captionStyle.fontFamily}
          onChange={(e) => onStyleChange({ fontFamily: e.target.value })}
          className="text-[11px] px-1.5 py-1 rounded"
          style={{
            border: "1px solid var(--snippy-border)",
            background: "var(--snippy-card)",
            fontFamily: `'${captionStyle.fontFamily}', sans-serif`,
          }}
        >
          {["Anton", "Bebas Neue", "Montserrat", "Oswald"].map((f) => (
            <option key={f} value={f} style={{ fontFamily: `'${f}', sans-serif` }}>
              {f}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-2">
        <MiniSlider
          label="size"
          min={24}
          max={160}
          value={captionStyle.fontSize}
          suffix="px"
          onChange={(v) => onStyleChange({ fontSize: v })}
        />
        <MiniSlider
          label="stroke"
          min={0}
          max={14}
          value={captionStyle.strokeWidth}
          suffix="px"
          onChange={(v) => onStyleChange({ strokeWidth: v })}
        />
        <MiniSlider
          label="x"
          min={0}
          max={100}
          value={Math.round(captionStyle.xPct * 100)}
          suffix="%"
          onChange={(v) => onStyleChange({ xPct: v / 100 })}
        />
        <MiniSlider
          label="y"
          min={0}
          max={100}
          value={Math.round(captionStyle.yPct * 100)}
          suffix="%"
          onChange={(v) => onStyleChange({ yPct: v / 100 })}
        />
        <MiniSlider
          label="width"
          min={20}
          max={100}
          value={Math.round(captionStyle.widthPct * 100)}
          suffix="%"
          onChange={(v) => onStyleChange({ widthPct: v / 100 })}
        />
        <MiniSlider
          label="wpl"
          min={2}
          max={8}
          value={captionStyle.wordsPerLine}
          onChange={(v) => onStyleChange({ wordsPerLine: v })}
        />
      </div>

      <div
        className="flex items-center gap-3 py-1.5"
        style={{ fontSize: 11, color: "var(--snippy-text-secondary)" }}
      >
        <Swatch
          label="active"
          value={captionStyle.activeColor}
          onChange={(v) => onStyleChange({ activeColor: v })}
        />
        <Swatch
          label="inactive"
          value={captionStyle.inactiveColor}
          onChange={(v) => onStyleChange({ inactiveColor: v })}
        />
        <Swatch
          label="stroke"
          value={captionStyle.strokeColor}
          onChange={(v) => onStyleChange({ strokeColor: v })}
        />
        <div className="flex-1" />
        <label
          className="flex items-center gap-1 cursor-pointer"
          style={{ fontSize: 10 }}
        >
          <input
            type="checkbox"
            checked={captionStyle.bgEnabled}
            onChange={(e) => onStyleChange({ bgEnabled: e.target.checked })}
            className="scale-90"
          />
          bg
        </label>
        {captionStyle.bgEnabled && (
          <>
            <Swatch
              value={captionStyle.bgColor}
              onChange={(v) => onStyleChange({ bgColor: v })}
            />
            <input
              type="range"
              min={10}
              max={100}
              value={captionStyle.bgOpacity}
              onChange={(e) => onStyleChange({ bgOpacity: Number(e.target.value) })}
              className="snippy-range"
              style={{ width: 60 }}
            />
          </>
        )}
      </div>
      </>)}

      {!hideWordList && sourceCaptions.length > 0 && (
        <div
          className="mt-3 pt-3"
          style={{ borderTop: "1px solid var(--snippy-border)" }}
        >
          <CaptionWordList
            sourceCaptions={sourceCaptions}
            startSec={startSec}
            endSec={endSec}
            playheadSec={playheadSec}
            onWordEdit={onWordEdit}
            onWordDelete={onWordDelete}
            onWordSeek={onWordSeek}
          />
        </div>
      )}
    </div>
  );
}

function MiniSlider({
  label,
  min,
  max,
  value,
  suffix,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="snippy-field">
      <span className="snippy-field-label" style={{ minWidth: 36 }}>
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
      <span className="snippy-value">
        {value}
        {suffix || ""}
      </span>
    </div>
  );
}

function Swatch({
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
          style={{ opacity: 0, position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
      </span>
      {label && <span style={{ fontSize: 10 }}>{label}</span>}
    </label>
  );
}

interface IndexedWord {
  w: WordTimestamp;
  i: number;
}

function groupIntoLines(
  words: IndexedWord[],
  opts: { maxWordsPerLine: number; maxGapSec: number }
): IndexedWord[][] {
  const lines: IndexedWord[][] = [];
  let current: IndexedWord[] = [];
  let lastEnd = -Infinity;
  for (const w of words) {
    const gap = w.w.start - lastEnd;
    if (
      current.length > 0 &&
      (current.length >= opts.maxWordsPerLine || gap > opts.maxGapSec)
    ) {
      lines.push(current);
      current = [];
    }
    current.push(w);
    lastEnd = w.w.end;
  }
  if (current.length) lines.push(current);
  return lines;
}

function fmtTs(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function CaptionWordList({
  sourceCaptions,
  startSec,
  endSec,
  playheadSec,
  onWordEdit,
  onWordDelete,
  onWordSeek,
}: {
  sourceCaptions: WordTimestamp[];
  startSec: number | null;
  endSec: number | null;
  playheadSec: number;
  onWordEdit: (sourceIndex: number, text: string) => void;
  onWordDelete: (sourceIndex: number) => void;
  onWordSeek: (sourceSec: number) => void;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const hasSelection = startSec != null && endSec != null && endSec > startSec;
  const RENDER_CAP = 600;
  const allInRange: IndexedWord[] = sourceCaptions
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => {
      if (!hasSelection) return true;
      return w.end > startSec! && w.start < endSec!;
    });
  const visibleIndices = allInRange.slice(0, RENDER_CAP);
  const truncated = allInRange.length > RENDER_CAP;
  const scope = hasSelection ? "clip" : "source";

  const lines = useMemo(
    () => groupIntoLines(visibleIndices, { maxWordsPerLine: 10, maxGapSec: 1.5 }),
    [visibleIndices]
  );

  const activeWordIdx = sourceCaptions.findIndex(
    (w) => playheadSec >= w.start && playheadSec < w.end
  );

  return (
    <div>
      <div
        className="snippy-label mb-2 flex items-center gap-2 flex-wrap"
        style={{ fontSize: 11 }}
      >
        <span>
          {allInRange.length} word{allInRange.length === 1 ? "" : "s"} in {scope}
          {truncated && (
            <span
              style={{
                color: "var(--snippy-accent)",
                marginLeft: 6,
                textTransform: "none",
                letterSpacing: 0,
              }}
            >
              (first {RENDER_CAP} · mark IN/OUT to narrow)
            </span>
          )}
        </span>
        <span
          style={{
            color: "var(--snippy-text-secondary)",
            letterSpacing: 0,
            textTransform: "none",
          }}
        >
          · click a word or timestamp to seek · double-click to edit
        </span>
      </div>

      {lines.length === 0 ? (
        <div
          className="text-xs p-3 rounded"
          style={{
            color: "var(--snippy-text-secondary)",
            background: "var(--snippy-canvas)",
            border: "1px solid var(--snippy-border)",
          }}
        >
          {hasSelection
            ? "No words inside the selected clip range."
            : "No words transcribed."}
        </div>
      ) : (
        <div
          className="rounded px-2 py-2 max-h-64 overflow-y-auto"
          style={{
            background: "var(--snippy-canvas)",
            border: "1px solid var(--snippy-border)",
          }}
        >
          {lines.map((line, lineIdx) => (
            <TranscriptLine
              key={line[0].i}
              line={line}
              lineIdx={lineIdx}
              activeWordIdx={activeWordIdx}
              editingIdx={editingIdx}
              onRequestEdit={setEditingIdx}
              onEdit={onWordEdit}
              onDelete={onWordDelete}
              onSeek={onWordSeek}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptLine({
  line,
  activeWordIdx,
  editingIdx,
  onRequestEdit,
  onEdit,
  onDelete,
  onSeek,
}: {
  line: IndexedWord[];
  lineIdx: number;
  activeWordIdx: number;
  editingIdx: number | null;
  onRequestEdit: (idx: number | null) => void;
  onEdit: (idx: number, text: string) => void;
  onDelete: (idx: number) => void;
  onSeek: (sec: number) => void;
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  const lineContainsActive = line.some(({ i }) => i === activeWordIdx);
  const lineStart = line[0].w.start;

  useEffect(() => {
    if (lineContainsActive && lineRef.current) {
      lineRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [lineContainsActive]);

  return (
    <div
      ref={lineRef}
      className="flex gap-3 py-1 rounded hover:bg-black/[0.02]"
      style={{
        lineHeight: 1.55,
        fontSize: 14,
      }}
    >
      <button
        onClick={() => onSeek(lineStart)}
        className="flex-shrink-0 font-mono text-[11px] pt-1"
        style={{
          color: lineContainsActive
            ? "var(--snippy-accent)"
            : "var(--snippy-text-secondary)",
          minWidth: 40,
          textAlign: "right",
          background: "transparent",
          border: 0,
          cursor: "pointer",
          fontWeight: lineContainsActive ? 600 : 400,
        }}
        title={`Seek to ${lineStart.toFixed(2)}s`}
      >
        {fmtTs(lineStart)}
      </button>
      <div
        style={{
          color: "var(--snippy-text)",
          flex: 1,
        }}
      >
        {line.map(({ w, i }) => (
          <TranscriptWord
            key={i}
            word={w}
            index={i}
            isActive={i === activeWordIdx}
            isEditing={i === editingIdx}
            onRequestEdit={onRequestEdit}
            onEdit={(t) => onEdit(i, t)}
            onDelete={() => onDelete(i)}
            onSeek={() => onSeek(w.start)}
          />
        ))}
      </div>
    </div>
  );
}

function TranscriptWord({
  word,
  index,
  isActive,
  isEditing,
  onRequestEdit,
  onEdit,
  onDelete,
  onSeek,
}: {
  word: WordTimestamp;
  index: number;
  isActive: boolean;
  isEditing: boolean;
  onRequestEdit: (idx: number | null) => void;
  onEdit: (text: string) => void;
  onDelete: () => void;
  onSeek: () => void;
}) {
  const [draft, setDraft] = useState(word.text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setDraft(word.text);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, word.text]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next && next !== word.text) onEdit(next);
          if (!next) onDelete();
          onRequestEdit(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(word.text);
            onRequestEdit(null);
          }
        }}
        className="inline-block outline-none font-medium mx-0.5 px-1 rounded"
        style={{
          width: `${Math.max(3, draft.length + 1)}ch`,
          background: "var(--snippy-card)",
          border: "1px solid var(--snippy-accent)",
          color: "var(--snippy-text)",
          fontSize: 14,
          lineHeight: 1.2,
        }}
      />
    );
  }

  return (
    <span
      onClick={onSeek}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRequestEdit(index);
      }}
      title={`${word.start.toFixed(2)}s · double-click to edit`}
      style={{
        cursor: "pointer",
        color: isActive ? "var(--snippy-accent)" : "inherit",
        fontWeight: isActive ? 600 : 400,
        background: isActive ? "var(--snippy-selection)" : "transparent",
        borderRadius: 3,
        padding: "0 1px",
        transition: "background-color 120ms ease-out",
      }}
      onMouseEnter={(e) =>
        !isActive &&
        ((e.currentTarget.style.background = "rgba(0,0,0,0.06)"),
        (e.currentTarget.style.color = "var(--snippy-accent)"))
      }
      onMouseLeave={(e) =>
        !isActive &&
        ((e.currentTarget.style.background = "transparent"),
        (e.currentTarget.style.color = "inherit"))
      }
    >
      {word.text}
      {" "}
    </span>
  );
}
