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

/* ── All Vizard API params with docs ── */
const VIZARD_PARAMS_DOCS: {
  key: string;
  type: string;
  values: string;
  default: string;
  description: string;
}[] = [
  {
    key: "videoUrl",
    type: "string",
    values: "URL",
    default: "—",
    description: "YouTube, Vimeo, Google Drive, StreamYard, or remote file URL",
  },
  {
    key: "videoType",
    type: "int",
    values: "2",
    default: "2",
    description: "2 = YouTube (use 2 for all YouTube URLs)",
  },
  {
    key: "lang",
    type: "string",
    values: '"en", "es", "fr", etc.',
    default: '"en"',
    description: "Language code. 30+ languages supported",
  },
  {
    key: "preferLength",
    type: "int[]",
    values: "[0], [1], [2], [3]",
    default: "[0]",
    description: "0=auto, 1=short (<30s), 2=medium (30-60s), 3=long (60-90s)",
  },
  {
    key: "ratioOfClip",
    type: "int",
    values: "1, 2, 3, 4",
    default: "1",
    description: "1=9:16 vertical, 2=1:1 square, 3=4:5 portrait, 4=16:9 horizontal",
  },
  {
    key: "maxClipNumber",
    type: "int",
    values: "1–100",
    default: "all",
    description:
      "Max clips returned, ranked by viral score. If video generates 40, only top N returned",
  },
  {
    key: "keywords",
    type: "string",
    values: "free text",
    default: "none",
    description:
      'Filter for specific moments/topics. E.g. "AI safety, alignment". Clips match these themes',
  },
  {
    key: "subtitleSwitch",
    type: "int",
    values: "0, 1",
    default: "1",
    description: "Bake subtitles into the clip video",
  },
  {
    key: "headlineSwitch",
    type: "int",
    values: "0, 1",
    default: "1",
    description: "AI-generated headline/hook text overlay on clip",
  },
  {
    key: "removeSilenceSwitch",
    type: "int",
    values: "0, 1",
    default: "0",
    description: "Remove silent gaps and filler words from clip",
  },
  {
    key: "emojiSwitch",
    type: "int",
    values: "0, 1",
    default: "0",
    description: "Auto-add emoji to subtitle text",
  },
  {
    key: "highlightSwitch",
    type: "int",
    values: "0, 1",
    default: "0",
    description: "Auto-highlight keywords in subtitles",
  },
  {
    key: "autoBrollSwitch",
    type: "int",
    values: "0, 1",
    default: "0",
    description: "Auto-add B-roll footage to clips",
  },
  {
    key: "templateId",
    type: "int",
    values: "template ID",
    default: "none",
    description: "Custom template for subtitle styling, branding, logo placement",
  },
  {
    key: "projectName",
    type: "string",
    values: "free text",
    default: "auto",
    description: "Custom name for the project (defaults to video title)",
  },
];

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function scoreColor(score: number) {
  if (score >= 8) return "bg-green-500 text-white";
  if (score >= 5) return "bg-yellow-500 text-white";
  return "bg-gray-400 text-white";
}

function parseTopics(raw: string): string[] {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/* ── Clip Card ── */
function ClipCard({
  clip,
  index,
  selected,
  onSelect,
  slotLabel,
}: {
  clip: VizardClip;
  index: number;
  selected: boolean;
  onSelect: (category: "viral" | "ai_safety") => void;
  slotLabel?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const score = parseFloat(clip.viralScore) || 0;
  const topics = parseTopics(clip.relatedTopic);

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
        {/* Rank */}
        <span className="absolute top-2 left-2 bg-black/70 text-white text-[10px] font-bold w-6 h-6 rounded-full flex items-center justify-center">
          {index + 1}
        </span>
        {/* Duration */}
        <span className="absolute bottom-2 right-2 bg-black/75 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded">
          {formatDuration(clip.videoMsDuration)}
        </span>
        {/* Score */}
        <span
          className={`absolute top-2 right-2 ${scoreColor(score)} text-[10px] font-bold px-2 py-0.5 rounded-full`}
        >
          {clip.viralScore}/10
        </span>
        {/* Selected label */}
        {selected && slotLabel && (
          <span className="absolute bottom-2 left-2 bg-blue-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">
            {slotLabel}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="p-3 space-y-2">
        {/* Title */}
        <h4 className="text-sm font-semibold text-gray-900 leading-snug">
          {clip.title}
        </h4>

        {/* Topics */}
        {topics.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {topics.map((t) => (
              <span
                key={t}
                className="text-[9px] font-medium bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded"
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {/* Metadata row */}
        <div className="flex items-center gap-2 text-[10px] text-gray-400">
          <span>ID: {clip.videoId}</span>
          <span>·</span>
          <span>{formatDuration(clip.videoMsDuration)}</span>
          <span>·</span>
          <span>{(clip.videoMsDuration / 1000).toFixed(1)}s</span>
        </div>

        {/* Expandable details */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-xs text-blue-600 hover:underline"
        >
          {showDetails ? "Hide details ▴" : "Show all details ▾"}
        </button>

        {showDetails && (
          <div className="space-y-2 border-t border-gray-100 pt-2">
            {/* Viral reason */}
            <div>
              <span className="text-[10px] font-semibold text-gray-500 uppercase">
                Viral Reason
              </span>
              <p className="text-xs text-gray-600 leading-relaxed mt-0.5">
                {clip.viralReason}
              </p>
            </div>

            {/* Full transcript */}
            <div>
              <span className="text-[10px] font-semibold text-gray-500 uppercase">
                Transcript
              </span>
              <p className="text-xs text-gray-500 leading-relaxed mt-0.5 max-h-32 overflow-y-auto">
                {clip.transcript}
              </p>
            </div>

            {/* Raw data */}
            <div>
              <span className="text-[10px] font-semibold text-gray-500 uppercase">
                All Vizard Fields
              </span>
              <div className="mt-1 text-[10px] font-mono bg-gray-50 rounded p-2 space-y-0.5 max-h-40 overflow-y-auto">
                <div>
                  <span className="text-gray-400">videoId:</span>{" "}
                  <span className="text-gray-700">{clip.videoId}</span>
                </div>
                <div>
                  <span className="text-gray-400">viralScore:</span>{" "}
                  <span className="text-gray-700">{clip.viralScore}</span>
                </div>
                <div>
                  <span className="text-gray-400">videoMsDuration:</span>{" "}
                  <span className="text-gray-700">
                    {clip.videoMsDuration}ms ({(clip.videoMsDuration / 1000).toFixed(1)}s)
                  </span>
                </div>
                <div>
                  <span className="text-gray-400">title:</span>{" "}
                  <span className="text-gray-700">{clip.title}</span>
                </div>
                <div>
                  <span className="text-gray-400">relatedTopic:</span>{" "}
                  <span className="text-gray-700">{clip.relatedTopic}</span>
                </div>
                <div>
                  <span className="text-gray-400">clipEditorUrl:</span>{" "}
                  <a
                    href={clip.clipEditorUrl}
                    target="_blank"
                    rel="noopener"
                    className="text-blue-500 hover:underline break-all"
                  >
                    {clip.clipEditorUrl}
                  </a>
                </div>
                <div>
                  <span className="text-gray-400">videoUrl:</span>{" "}
                  <span className="text-gray-700 break-all">
                    {clip.videoUrl.slice(0, 80)}...
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={() => onSelect("viral")}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              slotLabel === "Most Viral"
                ? "bg-red-100 text-red-700 ring-1 ring-red-300"
                : "bg-gray-100 text-gray-700 hover:bg-red-50 hover:text-red-700"
            }`}
          >
            {slotLabel === "Most Viral" ? "✓ Most Viral" : "Select: Most Viral"}
          </button>
          <button
            onClick={() => onSelect("ai_safety")}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              slotLabel === "AI Safety"
                ? "bg-blue-100 text-blue-700 ring-1 ring-blue-300"
                : "bg-gray-100 text-gray-700 hover:bg-blue-50 hover:text-blue-700"
            }`}
          >
            {slotLabel === "AI Safety" ? "✓ AI Safety" : "Select: AI Safety"}
          </button>
          {clip.clipEditorUrl && (
            <a
              href={clip.clipEditorUrl}
              target="_blank"
              rel="noopener"
              className="text-xs text-gray-400 hover:text-gray-600 ml-auto underline"
            >
              Edit in Vizard
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main Curator ── */
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

  const generalPrompt = {
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoType: 2,
    lang: "en",
    preferLength: [0],
    ratioOfClip: 4,
    maxClipNumber: 20,
    subtitleSwitch: 0,
    headlineSwitch: 0,
  };

  const safetyPrompt = {
    ...generalPrompt,
    keywords:
      "AI safety, existential risk, alignment, catastrophic risk, superintelligence",
  };

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
      const exportClips = [];
      if (selection.viral)
        exportClips.push({ ...selection.viral, category: "viral" });
      if (selection.ai_safety)
        exportClips.push({ ...selection.ai_safety, category: "ai_safety" });

      const res = await fetch("/api/clips/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, clips: exportClips }),
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

  const activeResponse =
    tab === "general" ? generalResponse : safetyResponse;

  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div className="flex gap-4">
        <img
          src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
          alt=""
          className="w-48 rounded-lg flex-shrink-0"
        />
        <div>
          <h1 className="text-lg font-bold text-gray-900 mb-0.5">
            Vizard Clip Curator
          </h1>
          <h2 className="text-base font-semibold text-blue-800 mb-1">
            {videoMeta.title}
          </h2>
          <div className="flex flex-wrap gap-2 text-xs text-gray-500">
            <span className="font-medium text-gray-700">
              {videoMeta.channel}
            </span>
            <span>{videoMeta.published}</span>
            {videoMeta.videoLength && <span>{videoMeta.videoLength}</span>}
            {videoMeta.speakers && <span>{videoMeta.speakers}</span>}
          </div>
          {activeResponse && (
            <div className="flex flex-wrap gap-3 mt-2 text-[10px] text-gray-400">
              <span>
                Project: <span className="font-mono">{activeResponse.projectId}</span>
              </span>
              {activeResponse.creditsUsed !== undefined && (
                <span>Credits used: {activeResponse.creditsUsed}</span>
              )}
              <span>{activeResponse.videos?.length ?? 0} clips returned</span>
            </div>
          )}
        </div>
      </div>

      {/* Prompt reference — all params */}
      <details className="bg-gray-50 border border-gray-200 rounded-lg">
        <summary className="px-4 py-2 text-sm font-medium text-gray-700 cursor-pointer">
          Vizard API Reference — All Parameters
        </summary>
        <div className="px-4 pb-4 space-y-4">
          {/* Params table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-[10px] font-semibold text-gray-500 uppercase border-b">
                  <th className="py-1.5 pr-3">Param</th>
                  <th className="py-1.5 pr-3">Type</th>
                  <th className="py-1.5 pr-3">Values</th>
                  <th className="py-1.5 pr-3">Default</th>
                  <th className="py-1.5">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {VIZARD_PARAMS_DOCS.map((p) => (
                  <tr key={p.key} className="text-gray-700">
                    <td className="py-1.5 pr-3 font-mono font-medium text-blue-700">
                      {p.key}
                    </td>
                    <td className="py-1.5 pr-3 text-gray-400">{p.type}</td>
                    <td className="py-1.5 pr-3 font-mono text-[10px]">
                      {p.values}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[10px]">
                      {p.default}
                    </td>
                    <td className="py-1.5 text-gray-500">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Response fields */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
              Response Fields Per Clip
            </h4>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-[10px] font-semibold text-gray-500 uppercase border-b">
                  <th className="py-1.5 pr-3">Field</th>
                  <th className="py-1.5 pr-3">Type</th>
                  <th className="py-1.5">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {[
                  ["videoId", "int", "Vizard internal clip ID"],
                  ["title", "string", "AI-generated clip title/hook"],
                  ["viralScore", "string", "0–10 virality rating"],
                  [
                    "viralReason",
                    "string",
                    "Why this clip is viral — engagement analysis",
                  ],
                  [
                    "relatedTopic",
                    "string (JSON array)",
                    'Topics/tags, e.g. ["AI safety","AGI"]',
                  ],
                  ["transcript", "string", "Full clip transcript text"],
                  [
                    "videoUrl",
                    "string",
                    "CDN URL for MP4 download (expires in 7 days)",
                  ],
                  ["videoMsDuration", "int", "Clip duration in milliseconds"],
                  [
                    "clipEditorUrl",
                    "string",
                    "Link to edit this clip in Vizard web editor",
                  ],
                ].map(([field, type, desc]) => (
                  <tr key={field} className="text-gray-700">
                    <td className="py-1.5 pr-3 font-mono font-medium text-blue-700">
                      {field}
                    </td>
                    <td className="py-1.5 pr-3 text-gray-400">{type}</td>
                    <td className="py-1.5 text-gray-500">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Actual prompts used */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">
                General Prompt Used
              </h4>
              <pre className="text-[10px] font-mono bg-white border rounded p-2 overflow-auto max-h-48">
                {JSON.stringify(generalPrompt, null, 2)}
              </pre>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">
                AI Safety Prompt Used
              </h4>
              <pre className="text-[10px] font-mono bg-white border rounded p-2 overflow-auto max-h-48">
                {JSON.stringify(safetyPrompt, null, 2)}
              </pre>
            </div>
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

      {/* Stats bar */}
      {sortedClips.length > 0 && (
        <div className="flex flex-wrap gap-4 text-xs text-gray-500 bg-gray-50 rounded-lg px-4 py-2">
          <span>
            <span className="font-semibold text-gray-700">
              {sortedClips.length}
            </span>{" "}
            clips
          </span>
          <span>
            Avg score:{" "}
            <span className="font-semibold text-gray-700">
              {(
                sortedClips.reduce(
                  (s, c) => s + (parseFloat(c.viralScore) || 0),
                  0
                ) / sortedClips.length
              ).toFixed(1)}
            </span>
          </span>
          <span>
            Total duration:{" "}
            <span className="font-semibold text-gray-700">
              {formatDuration(
                sortedClips.reduce((s, c) => s + c.videoMsDuration, 0)
              )}
            </span>
          </span>
          <span>
            Avg clip:{" "}
            <span className="font-semibold text-gray-700">
              {formatDuration(
                sortedClips.reduce((s, c) => s + c.videoMsDuration, 0) /
                  sortedClips.length
              )}
            </span>
          </span>
          <span>
            Score range:{" "}
            <span className="font-semibold text-gray-700">
              {sortedClips[sortedClips.length - 1]?.viralScore}–
              {sortedClips[0]?.viralScore}
            </span>
          </span>
        </div>
      )}

      {/* No data */}
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
            index={i}
            selected={isSelected(clip)}
            slotLabel={getSlotLabel(clip)}
            onSelect={(category) => handleSelect(clip, category)}
          />
        ))}
      </div>

      {/* Selection panel (sticky bottom) */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 px-6 py-3">
          <div className="flex gap-6 min-w-0">
            <div className="min-w-0">
              <span className="text-[10px] font-semibold text-red-600 uppercase">
                Most Viral
              </span>
              <p className="text-xs text-gray-800 truncate max-w-[200px]">
                {selection.viral?.title ?? (
                  <span className="text-gray-400 italic">Not selected</span>
                )}
              </p>
              {selection.viral && (
                <span className="text-[10px] text-gray-400">
                  {selection.viral.viralScore}/10 ·{" "}
                  {formatDuration(selection.viral.videoMsDuration)}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-semibold text-blue-600 uppercase">
                AI Safety
              </span>
              <p className="text-xs text-gray-800 truncate max-w-[200px]">
                {selection.ai_safety?.title ?? (
                  <span className="text-gray-400 italic">Not selected</span>
                )}
              </p>
              {selection.ai_safety && (
                <span className="text-[10px] text-gray-400">
                  {selection.ai_safety.viralScore}/10 ·{" "}
                  {formatDuration(selection.ai_safety.videoMsDuration)}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={handleExport}
            disabled={selectedCount === 0 || exporting}
            className="flex-shrink-0 px-6 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
