"use client";

import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheckCircle2, XCircle, SkipForward, ExternalLink, Loader2, CheckCheck, ArrowUp, ArrowDown } from "lucide-react";

interface Candidate {
  video_id: string;
  title: string;
  channel: string;
  duration_seconds: number;
  published_at: string;
  confidence: number;
  category: string;
  status: string;
  processing_status: string | null;
  processing_error: string | null;
  processing_step: string | null;
  processing_steps_json: string | null;
}

type SortField = "title" | "channel" | "confidence" | "duration_seconds" | "published_at";
type SortDir = "asc" | "desc";

function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function confidenceBadge(conf: number) {
  const color =
    conf >= 90 ? "bg-green-100 text-green-800" :
    conf >= 70 ? "bg-blue-100 text-blue-800" :
    conf >= 50 ? "bg-yellow-100 text-yellow-800" :
    "bg-red-100 text-red-800";
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {conf}
    </span>
  );
}

const STEP_ORDER = ["bigquery", "speaker_id", "vector_store", "gcs_download"];
const STEP_SHORT = { bigquery: "BQ", speaker_id: "ID", vector_store: "Vec", gcs_download: "GCS" };

function StepProgressBar({ processingStep, stepsJson, onStepClick }: { processingStep: string | null; stepsJson: string | null; onStepClick: (step: string, data: any) => void }) {
  let steps: Record<string, any> = {};
  try { if (stepsJson) steps = JSON.parse(stepsJson); } catch {}

  return (
    <div className="flex gap-0.5">
      {STEP_ORDER.map((step) => {
        const data = steps[step];
        const status = data?.status || (processingStep === step ? "active" : "pending");
        const colors: Record<string, string> = {
          complete: "bg-green-500",
          active: "bg-blue-500 animate-pulse",
          failed: "bg-red-500",
          skipped: "bg-gray-300",
          pending: "bg-gray-200",
        };
        return (
          <button
            key={step}
            title={`${(STEP_SHORT as any)[step]}: ${status}`}
            className={`w-5 h-5 rounded text-[9px] font-bold text-white flex items-center justify-center cursor-pointer hover:opacity-80 ${colors[status] || colors.pending}`}
            onClick={(e) => { e.stopPropagation(); if (data) onStepClick(step, data); }}
          >
            {(STEP_SHORT as any)[step]}
          </button>
        );
      })}
    </div>
  );
}

function statusBadge(status: string, processingStatus: string | null) {
  if (status === "approved" && !processingStatus) return <CheckCircle2 className="w-4 h-4 text-green-500" />;
  if (status === "rejected" || status?.startsWith("rejected_")) return <XCircle className="w-4 h-4 text-red-400" />;
  if (status === "skipped") return <SkipForward className="w-4 h-4 text-gray-400" />;
  if (processingStatus === "queued") return <Loader2 className="w-4 h-4 text-gray-400" />;
  return null;
}

function SortIcon({ field, sortField, sortDir }: { field: SortField; sortField: SortField | null; sortDir: SortDir }) {
  if (sortField !== field) return <ArrowDown className="w-3 h-3 opacity-0 group-hover:opacity-30 inline ml-1" />;
  return sortDir === "asc"
    ? <ArrowUp className="w-3 h-3 inline ml-1" />
    : <ArrowDown className="w-3 h-3 inline ml-1" />;
}

export function CandidateTable({
  candidates,
  selectedIds,
  onSelectionChange,
  onRowClick,
  onApprove,
  onReject,
  onSkip,
  onStepClick,
}: {
  candidates: Candidate[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onRowClick: (c: any) => void;
  onApprove: (videoId: string) => void;
  onReject: (c: any) => void;
  onSkip: (videoId: string) => void;
  onStepClick?: (step: string, data: any) => void;
}) {
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "title" || field === "channel" ? "asc" : "desc");
    }
  }

  const sorted = useMemo(() => {
    if (!sortField) return candidates;
    return [...candidates].sort((a, b) => {
      let av: any = a[sortField];
      let bv: any = b[sortField];
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [candidates, sortField, sortDir]);

  const allSelected = candidates.length > 0 && candidates.every((c) => selectedIds.has(c.video_id));

  function toggleAll() {
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(candidates.map((c) => c.video_id)));
    }
  }

  function toggleOne(videoId: string) {
    const next = new Set(selectedIds);
    if (next.has(videoId)) next.delete(videoId);
    else next.add(videoId);
    onSelectionChange(next);
  }

  function sortableHeader(label: string, field: SortField, className?: string) {
    return (
      <TableHead
        className={`${className || ""} cursor-pointer select-none group`}
        onClick={() => handleSort(field)}
      >
        {label}
        <SortIcon field={field} sortField={sortField} sortDir={sortDir} />
      </TableHead>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="rounded"
            />
          </TableHead>
          <TableHead className="w-8"></TableHead>
          {sortableHeader("Title", "title")}
          {sortableHeader("Channel", "channel")}
          {sortableHeader("Score", "confidence", "w-20 text-center")}
          {sortableHeader("Duration", "duration_seconds", "w-20")}
          {sortableHeader("Date", "published_at", "w-24")}
          <TableHead className="w-20">Type</TableHead>
          <TableHead className="w-32 text-center">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((c) => (
          <TableRow
            key={c.video_id}
            className="cursor-pointer hover:bg-gray-50"
            onClick={() => onRowClick(c)}
          >
            <TableCell onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={selectedIds.has(c.video_id)}
                onChange={() => toggleOne(c.video_id)}
                className="rounded"
              />
            </TableCell>
            <TableCell>
              {c.processing_status && c.processing_status !== "queued" ? (
                <StepProgressBar
                  processingStep={c.processing_step}
                  stepsJson={c.processing_steps_json}
                  onStepClick={onStepClick || (() => {})}
                />
              ) : (
                statusBadge(c.status, c.processing_status)
              )}
            </TableCell>
            <TableCell className="max-w-[400px]">
              <div className="truncate font-medium" title={c.title}>
                {c.title}
              </div>
            </TableCell>
            <TableCell className="text-gray-600 truncate max-w-[150px]">
              {c.channel}
            </TableCell>
            <TableCell className="text-center">{confidenceBadge(c.confidence)}</TableCell>
            <TableCell className="text-gray-500 font-mono text-xs">
              {formatDuration(c.duration_seconds)}
            </TableCell>
            <TableCell className="text-gray-500 text-xs">{c.published_at}</TableCell>
            <TableCell className="text-gray-500 text-xs capitalize">{c.category}</TableCell>
            <TableCell onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-1">
                {c.status === "pending" && (
                  <>
                    <button
                      className="p-1 rounded hover:bg-green-100"
                      title="Approve"
                      onClick={() => onApprove(c.video_id)}
                    >
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-red-100"
                      title="Reject"
                      onClick={() => onReject(c)}
                    >
                      <XCircle className="w-4 h-4 text-red-500" />
                    </button>
                    <button
                      className="p-1 rounded hover:bg-gray-100"
                      title="Skip"
                      onClick={() => onSkip(c.video_id)}
                    >
                      <SkipForward className="w-4 h-4 text-gray-400" />
                    </button>
                  </>
                )}
                <a
                  href={`https://www.youtube.com/watch?v=${c.video_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1 rounded hover:bg-blue-100"
                  title="Open on YouTube"
                >
                  <ExternalLink className="w-4 h-4 text-blue-500" />
                </a>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
