"use client";

import { useState, useRef } from "react";
import type { VizardClip, VizardResponse } from "@/lib/types/clip";
import { toast } from "sonner";

type VideoMeta = {
  title: string;
  channel: string;
  published: string;
  videoLength: string | null;
  speakers: string | null;
};

type Selection = {
  viral: VizardClip | null;
  ai_safety: VizardClip | null;
};

const VIZARD_GENERAL_PROMPT = {
  videoUrl: "https://www.youtube.com/watch?v={videoId}",
  videoType: 2,
  lang: "en",
  preferLength: [0],
  ratioOfClip: 4,
  maxClipNumber: 20,
  subtitleSwitch: 0,
  headlineSwitch: 0,
};

const VIZARD_SAFETY_PROMPT = {
  ...VIZARD_GENERAL_PROMPT,
  keywords:
    "AI safety, existential risk, alignment, catastrophic risk, superintelligence",
};

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function scoreColor(score: number) {
  if (score >= 8) return "bg-green-500";
  if (score >= 5) return "bg-yellow-500";
  return "bg-gray-400";
}

function ClipCard({
  clip,
  selected,
  onSelect,
  slotLabel,
}: {
  clip: VizardClip;
  selected: boolean;
  onSelect: (category: "viral" | "ai_safety") => void;
  slotLabel?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const score = parseFloat(clip.viralScore) || 0;

  return (
    <div
      className={`rounded-xl border bg-white overflow-hidden transition-all ${
        selected
          ? "border-blue-500 ring-2 ring-blue-200"
          : "border-gray-200 hover:border-blue-300 hover:shadow-md"
      }`}
    >
      {/* Video preview */}
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          src={clip.videoUrl}
          className="w-full h-full object-cover"
          onClick={() => {
            if (playing) {
              videoRef.current?.pause();
              setPlaying(false);
            } else {
              videoRef.current?.play();
              setPlaying(true);
            }
          }}
          onEnded={() => setPlaying(false)}
        />
        {!playing && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/20 cursor-pointer"
            onClick={() => {
              videoRef.current?.play();
              setPlaying(true);
            }}
          >
            <div className="w-12 h-12 bg-black/60 rounded-full flex items-center justify-center">
              <svg
                className="w-5 h-5 text-white ml-0.5"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <polygon points="8,5 20,12 8,19" />
              </svg>
            </div>
          </div>
        )}
        <span className="absolute bottom-2 right-2 bg-black/75 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded">
          {formatDuration(clip.videoMsDuration)}
        </span>
        <span
          className={`absolute top-2 right-2 ${scoreColor(score)} text-white text-[10px] font-bold px-2 py-0.5 rounded-full`}
        >
          {clip.viralScore}/10
        </span>
        {selected && slotLabel && (
          <span className="absolute top-2 left-2 bg-blue-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase">
            {slotLabel}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="p-3 space-y-2">
        <h4 className="text-sm font-semibold text-gray-900 line-clamp-2">
          {clip.title}
        </h4>

        {/* Viral reason */}
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-blue-600 hover:underline"
          >
            {expanded ? "Hide reason" : "Why viral?"}
          </button>
          {expanded && (
            <p className="text-xs text-gray-600 mt-1 leading-relaxed">
              {clip.viralReason}
            </p>
          )}
        </div>

        {/* Transcript */}
        <p className="text-xs text-gray-500 line-clamp-3 leading-relaxed">
          {clip.transcript}
        </p>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => onSelect("viral")}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              selected
                ? "bg-blue-100 text-blue-700"
                : "bg-gray-100 text-gray-700 hover:bg-red-50 hover:text-red-700"
            }`}
          >
            {selected ? "Selected ✓" : "Select: Most Viral"}
          </button>
          <button
            onClick={() => onSelect("ai_safety")}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              selected
                ? "bg-blue-100 text-blue-700"
                : "bg-gray-100 text-gray-700 hover:bg-blue-50 hover:text-blue-700"
            }`}
          >
            {selected ? "Selected ✓" : "Select: AI Safety"}
          </button>
          {clip.clipEditorUrl && (
            <a
              href={clip.clipEditorUrl}
              target="_blank"
              rel="noopener"
              className="text-xs text-gray-400 hover:text-gray-600 ml-auto underline"
            >
              Vizard editor
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function VizardCurator({
  videoId,
  videoMeta,
  generalResponse,
  safetyResponse,
}: {
  videoId: string;
  videoMeta: VideoMeta;
  generalResponse: VizardResponse | null;
  safetyResponse: VizardResponse | null;
}) {
  const [tab, setTab] = useState<"general" | "safety">("general");
  const [selection, setSelection] = useState<Selection>({
    viral: null,
    ai_safety: null,
  });
  const [exporting, setExporting] = useState(false);

  const clips =
    tab === "general"
      ? generalResponse?.videos ?? []
      : safetyResponse?.videos ?? [];
  const sortedClips = [...clips].sort(
    (a, b) => parseFloat(b.viralScore) - parseFloat(a.viralScore)
  );

  const handleSelect = (clip: VizardClip, category: "viral" | "ai_safety") => {
    setSelection((prev) => ({
      ...prev,
      [category]: prev[category]?.videoId === clip.videoId ? null : clip,
    }));
  };

  const isSelected = (clip: VizardClip) =>
    selection.viral?.videoId === clip.videoId ||
    selection.ai_safety?.videoId === clip.videoId;

  const getSlotLabel = (clip: VizardClip) => {
    if (selection.viral?.videoId === clip.videoId) return "Most Viral";
    if (selection.ai_safety?.videoId === clip.videoId) return "AI Safety";
    return undefined;
  };

  const handleExport = async () => {
    if (!selection.viral && !selection.ai_safety) {
      toast.error("Select at least one clip to export");
      return;
    }
    setExporting(true);
    try {
      const clips = [];
      if (selection.viral)
        clips.push({ ...selection.viral, category: "viral" });
      if (selection.ai_safety)
        clips.push({ ...selection.ai_safety, category: "ai_safety" });

      const res = await fetch("/api/clips/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, clips }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }

      const result = await res.json();
      toast.success(
        `Exported ${result.exported} clip(s) to GCS + BigQuery!`
      );
    } catch (e: any) {
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };

  const selectedCount =
    (selection.viral ? 1 : 0) + (selection.ai_safety ? 1 : 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900 mb-1">
          Vizard Clip Curator
        </h1>
        <h2 className="text-lg font-semibold text-blue-800">
          {videoMeta.title}
        </h2>
        <div className="flex flex-wrap gap-3 text-sm text-gray-500 mt-1">
          <span className="font-medium text-gray-700">
            {videoMeta.channel}
          </span>
          <span>{videoMeta.published}</span>
          {videoMeta.videoLength && <span>{videoMeta.videoLength}</span>}
          {videoMeta.speakers && <span>{videoMeta.speakers}</span>}
        </div>
        <div className="mt-2">
          <img
            src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
            alt=""
            className="w-64 rounded-lg"
          />
        </div>
      </div>

      {/* Prompt display */}
      <details className="bg-gray-50 border border-gray-200 rounded-lg">
        <summary className="px-4 py-2 text-sm font-medium text-gray-700 cursor-pointer">
          Vizard API Prompts
        </summary>
        <div className="px-4 pb-3 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">
              General Virality
            </h4>
            <pre className="text-xs bg-white border rounded p-2 overflow-auto max-h-40">
              {JSON.stringify(
                { ...VIZARD_GENERAL_PROMPT, videoUrl: VIZARD_GENERAL_PROMPT.videoUrl.replace("{videoId}", videoId) },
                null,
                2
              )}
            </pre>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">
              AI Safety Keywords
            </h4>
            <pre className="text-xs bg-white border rounded p-2 overflow-auto max-h-40">
              {JSON.stringify(
                { ...VIZARD_SAFETY_PROMPT, videoUrl: VIZARD_SAFETY_PROMPT.videoUrl.replace("{videoId}", videoId) },
                null,
                2
              )}
            </pre>
          </div>
        </div>
      </details>

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab("general")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === "general"
              ? "bg-red-100 text-red-800"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          General Virality ({generalResponse?.videos?.length ?? 0})
        </button>
        <button
          onClick={() => setTab("safety")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === "safety"
              ? "bg-blue-100 text-blue-800"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          AI Safety ({safetyResponse?.videos?.length ?? 0})
        </button>
      </div>

      {/* No data state */}
      {sortedClips.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg mb-2">No clips available for this tab.</p>
          <p className="text-sm">
            Run the Vizard API and save the response JSON to{" "}
            <code className="bg-gray-100 px-1 rounded">
              src/data/vizard-{videoId}-
              {tab === "general" ? "general" : "safety"}.json
            </code>
          </p>
        </div>
      )}

      {/* Clip grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {sortedClips.map((clip, i) => (
          <ClipCard
            key={`${clip.videoId}-${i}`}
            clip={clip}
            selected={isSelected(clip)}
            slotLabel={getSlotLabel(clip)}
            onSelect={(category) => handleSelect(clip, category)}
          />
        ))}
      </div>

      {/* Selection panel (sticky bottom) */}
      <div className="sticky bottom-0 bg-white border-t border-gray-200 shadow-lg rounded-t-xl p-4 -mx-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex gap-6">
            <div>
              <span className="text-xs font-semibold text-red-600 uppercase">
                Most Viral
              </span>
              <p className="text-sm text-gray-800 truncate max-w-xs">
                {selection.viral?.title ?? (
                  <span className="text-gray-400 italic">Not selected</span>
                )}
              </p>
            </div>
            <div>
              <span className="text-xs font-semibold text-blue-600 uppercase">
                AI Safety
              </span>
              <p className="text-sm text-gray-800 truncate max-w-xs">
                {selection.ai_safety?.title ?? (
                  <span className="text-gray-400 italic">Not selected</span>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={handleExport}
            disabled={selectedCount === 0 || exporting}
            className="px-6 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {exporting
              ? "Exporting..."
              : `Export ${selectedCount} Clip${selectedCount !== 1 ? "s" : ""} → GCS + BigQuery`}
          </button>
        </div>
      </div>
    </div>
  );
}
