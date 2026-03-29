"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheckCircle2, XCircle, SkipForward, ExternalLink, Loader2, CheckCheck } from "lucide-react";

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
}

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

function statusBadge(status: string, processingStatus: string | null) {
  if (processingStatus === "complete") return <CheckCheck className="w-4 h-4 text-green-600" />;
  if (processingStatus === "processing") return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
  if (processingStatus === "queued") return <Loader2 className="w-4 h-4 text-gray-400" />;
  if (processingStatus === "failed") return <XCircle className="w-4 h-4 text-red-500" />;
  if (status === "approved") return <CheckCircle2 className="w-4 h-4 text-green-500" />;
  if (status === "rejected") return <XCircle className="w-4 h-4 text-red-400" />;
  if (status === "skipped") return <SkipForward className="w-4 h-4 text-gray-400" />;
  return null;
}

export function CandidateTable({
  candidates,
  selectedIds,
  onSelectionChange,
  onRowClick,
  onApprove,
  onReject,
  onSkip,
}: {
  candidates: Candidate[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onRowClick: (c: any) => void;
  onApprove: (videoId: string) => void;
  onReject: (c: any) => void;
  onSkip: (videoId: string) => void;
}) {
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
          <TableHead>Title</TableHead>
          <TableHead>Channel</TableHead>
          <TableHead className="w-20 text-center">Score</TableHead>
          <TableHead className="w-20">Duration</TableHead>
          <TableHead className="w-24">Date</TableHead>
          <TableHead className="w-20">Type</TableHead>
          <TableHead className="w-32 text-center">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {candidates.map((c) => (
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
            <TableCell>{statusBadge(c.status, c.processing_status)}</TableCell>
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
