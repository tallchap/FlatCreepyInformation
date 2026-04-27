"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SnippyPlayer, type SnippyPlayerHandle } from "./snippy-player";
import { SnippyTimeline, type SnippyTimelineHandle } from "./snippy-timeline";
import { SnippyBunnyPicker, type BunnyItem } from "./snippy-bunny-picker";
import { SnippyPlayerIframe } from "./snippy-player-iframe";
import { ClipFinder } from "@/components/edit/clip-finder";

const MAX_CLIP_SEC = 10 * 60;

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SnippyClipSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [bunnyVideo, setBunnyVideo] = useState<BunnyItem | null>(null);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const [totalDuration, setTotalDuration] = useState(0);
  const [startSec, setStartSec] = useState<number | null>(null);
  const [endSec, setEndSec] = useState<number | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [transcriptLines, setTranscriptLines] = useState<{ start: number; text: string }[]>([]);
  const [clipFinderTab, setClipFinderTab] = useState<"finder" | "transcript">("finder");

  const playerRef = useRef<SnippyPlayerHandle>(null);
  const timelineRef = useRef<SnippyTimelineHandle>(null);
  const playerWrapRef = useRef<HTMLDivElement>(null);

  const videoUrl = bunnyVideo
    ? `/api/bunny-proxy?src=${encodeURIComponent(bunnyVideo.mp4Url || "")}`
    : "";

  const selectionValid = startSec != null && endSec != null && endSec > startSec;
  const clipDurationSec = selectionValid ? endSec! - startSec! : 0;
  const clipTooLong = clipDurationSec > MAX_CLIP_SEC;

  const inputFocused = () => {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
  };

  const markIn = useCallback(() => {
    if (inputFocused()) return;
    const sec = playerRef.current?.getCurrentTime() ?? playheadSec;
    const clamped = Math.max(0, Math.min(totalDuration, sec));
    setStartSec(clamped);
    if (endSec != null && clamped >= endSec) setEndSec(null);
  }, [playheadSec, totalDuration, endSec]);

  const markOut = useCallback(() => {
    if (inputFocused()) return;
    const sec = playerRef.current?.getCurrentTime() ?? playheadSec;
    const clamped = Math.max(0, Math.min(totalDuration, sec));
    setEndSec(clamped);
    if (startSec != null && clamped <= startSec) setStartSec(null);
  }, [playheadSec, totalDuration, startSec]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (inputFocused()) return;
      if (e.key === "i" || e.key === "I") { e.preventDefault(); markIn(); }
      else if (e.key === "o" || e.key === "O") { e.preventDefault(); markOut(); }
      else if (e.code === "Space") { e.preventDefault(); playerRef.current?.toggle(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); const t = playerRef.current?.getCurrentTime() ?? playheadSec; playerRef.current?.seekTo(Math.min(totalDuration, t + 5)); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); const t = playerRef.current?.getCurrentTime() ?? playheadSec; playerRef.current?.seekTo(Math.max(0, t - 5)); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [markIn, markOut]);

  const handlePickBunny = useCallback((v: BunnyItem) => {
    setBunnyVideo(v);
    setSourceCollapsed(true);
    setTotalDuration(v.length || 0);
    setStartSec(null);
    setEndSec(null);
    setPlayheadSec(0);
    const ytId = v.title || v.guid;
    if (ytId) {
      fetch(`/api/transcript/${ytId}`)
        .then((r) => r.ok ? r.json() : [])
        .then((data) => {
          if (Array.isArray(data)) setTranscriptLines(data);
        })
        .catch(() => {});
    }
  }, []);

  // Auto-select Bunny video when ?v=<youtubeId> is in the URL
  const autoSelectDone = useRef(false);
  useEffect(() => {
    const vParam = searchParams.get("v");
    if (!vParam || autoSelectDone.current) return;
    autoSelectDone.current = true;
    fetch(`/api/bunny/videos?search=${encodeURIComponent(vParam)}&itemsPerPage=50`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.items?.length) return;
        const match = data.items.find((i: BunnyItem) => i.title === vParam) || data.items[0];
        if (match.playable && match.mp4Url) handlePickBunny(match);
      })
      .catch(() => {});
  }, [searchParams, handlePickBunny]);

  const handleDurationDetected = useCallback((d: number) => {
    if (!d || !isFinite(d)) return;
    setTotalDuration((prev) => (Math.abs(prev - d) > 0.5 ? d : prev));
  }, []);

  const handleEditClip = () => {
    if (!bunnyVideo || !selectionValid || clipTooLong) return;
    router.push(`/snippy/edit?video=${bunnyVideo.guid}&in=${startSec!.toFixed(2)}&out=${endSec!.toFixed(2)}`);
  };

  const handleSnippetSelect = (start: number, end: number) => {
    setStartSec(start);
    setEndSec(end);
    playerRef.current?.seekTo(start);
  };

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 24px" }}>
      <div style={{ marginTop: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--snippy-text)" }}>Pick your clip</div>
        <div style={{ fontSize: 12, color: "var(--snippy-text-secondary)", marginTop: 2 }}>
          Select up to 10 minutes to edit with karaoke captions and text overlays
        </div>
      </div>

      <SnippyBunnyPicker
        onSelect={handlePickBunny}
        collapsed={sourceCollapsed}
        selectedVideo={bunnyVideo}
        onExpand={() => setSourceCollapsed(false)}
      />

      {bunnyVideo && videoUrl && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, marginTop: 16 }}>
            {/* Video */}
            <div ref={playerWrapRef} className="relative">
              <SnippyPlayer
                ref={playerRef}
                videoUrl={videoUrl}
                totalDuration={totalDuration || bunnyVideo.length || 60}
                inSec={startSec}
                outSec={endSec}
                playbackRate={playbackRate}
                onTimeUpdate={setPlayheadSec}
                onPlayingChange={setIsPlaying}
                onDurationDetected={handleDurationDetected}
              />
            </div>

            {/* Clip Finder panel — positioned to match video height */}
            <div style={{ position: "relative" }}>
            <div className="snippy-card" style={{ padding: 12, display: "flex", flexDirection: "column", overflow: "hidden", position: "absolute", inset: 0 }}>
              <div style={{ display: "flex", borderBottom: "2px solid var(--snippy-canvas, #f5f0ea)", marginBottom: 10 }}>
                <button
                  onClick={() => setClipFinderTab("finder")}
                  style={{
                    padding: "7px 14px", fontSize: 12, cursor: "pointer", border: "none", background: "none",
                    color: clipFinderTab === "finder" ? "#D97757" : "#999",
                    borderBottom: clipFinderTab === "finder" ? "2px solid #D97757" : "2px solid transparent",
                    fontWeight: clipFinderTab === "finder" ? 600 : 400, marginBottom: -2,
                  }}
                >Clip Finder</button>
                <button
                  onClick={() => setClipFinderTab("transcript")}
                  style={{
                    padding: "7px 14px", fontSize: 12, cursor: "pointer", border: "none", background: "none",
                    color: clipFinderTab === "transcript" ? "#D97757" : "#999",
                    borderBottom: clipFinderTab === "transcript" ? "2px solid #D97757" : "2px solid transparent",
                    fontWeight: clipFinderTab === "transcript" ? 600 : 400, marginBottom: -2,
                  }}
                >Transcript</button>
              </div>

              {clipFinderTab === "finder" && transcriptLines.length > 0 && (
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                  <ClipFinder
                    transcript={transcriptLines}
                    onSelectSnippet={handleSnippetSelect}
                    onClose={() => setClipFinderTab("transcript")}
                  />
                </div>
              )}

              {clipFinderTab === "finder" && transcriptLines.length === 0 && (
                <div style={{ textAlign: "center", padding: 24, fontSize: 11, color: "#999" }}>
                  Loading transcript for Clip Finder...
                </div>
              )}

              {clipFinderTab === "transcript" && (
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", fontSize: 12 }}>
                  {transcriptLines.length > 0 ? (
                    transcriptLines.map((line, i) => (
                      <div
                        key={i}
                        style={{ padding: "4px 0", cursor: "pointer", borderBottom: "1px solid var(--snippy-canvas, #f5f0ea)" }}
                        onClick={() => playerRef.current?.seekTo(line.start)}
                      >
                        <span style={{ fontFamily: "monospace", fontSize: 10, color: "#bbb", marginRight: 8 }}>
                          {fmt(line.start)}
                        </span>
                        {line.text}
                      </div>
                    ))
                  ) : (
                    <div style={{ textAlign: "center", padding: 24, color: "#999", fontSize: 11 }}>
                      Transcript loading...
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>
          </div>

          {/* Timeline */}
          <div style={{ marginTop: 12 }}>
            <SnippyTimeline
              ref={timelineRef}
              duration={totalDuration || bunnyVideo.length || 60}
              startSec={startSec}
              endSec={endSec}
              playheadSec={playheadSec}
              isPlaying={isPlaying}
              overlays={[]}
              captionCount={0}
              selectedLayerId={null}
              playbackRate={playbackRate}
              volume={volume}
              onStartChange={(s) => setStartSec(endSec != null && s >= endSec ? endSec - 0.1 : s)}
              onEndChange={(s) => setEndSec(startSec != null && s <= startSec ? startSec + 0.1 : s)}
              onSeek={(s) => { setPlayheadSec(s); playerRef.current?.seekTo(s); }}
              onMarkIn={markIn}
              onMarkOut={markOut}
              onTogglePlay={() => playerRef.current?.toggle()}
              onPlaybackRateChange={setPlaybackRate}
              onVolumeChange={(v) => { setVolume(v); playerRef.current?.setVolume(v); }}
              onLayerSelect={() => {}}
              onFit={() => {}}
            />
          </div>

          {/* Edit This Clip bar */}
          <div
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginTop: 18, padding: "14px 18px",
              background: selectionValid && !clipTooLong ? "#fff8f5" : "var(--snippy-card)",
              border: `2px solid ${selectionValid && !clipTooLong ? "#D97757" : "var(--snippy-border)"}`,
              borderRadius: 10,
            }}
          >
            <div>
              {selectionValid ? (
                <>
                  <div style={{ fontSize: 15, fontWeight: 600, fontFamily: "monospace" }}>
                    {fmt(startSec!)} → {fmt(endSec!)}
                  </div>
                  <div style={{ fontSize: 11, color: clipTooLong ? "#b94a2e" : "#999", marginTop: 2 }}>
                    {clipTooLong
                      ? `${fmt(Math.floor(clipDurationSec))} — exceeds 10 minute limit`
                      : `${Math.floor(clipDurationSec / 60)}m ${Math.floor(clipDurationSec % 60)}s`}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: "#999" }}>Mark IN and OUT to select a clip</div>
              )}
            </div>
            <button
              onClick={handleEditClip}
              disabled={!selectionValid || clipTooLong}
              style={{
                padding: "12px 32px",
                background: selectionValid && !clipTooLong ? "#D97757" : "#ccc",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 700,
                cursor: selectionValid && !clipTooLong ? "pointer" : "not-allowed",
                letterSpacing: 0.3,
                boxShadow: selectionValid && !clipTooLong ? "0 2px 8px rgba(217,119,87,0.25)" : "none",
              }}
            >
              Edit This Clip →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
