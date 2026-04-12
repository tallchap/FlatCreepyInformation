"use client";

import { useState } from "react";
import { X, ChevronDown, ChevronRight } from "lucide-react";

interface StepDetailDrawerProps {
  stepName: string;
  stepData: any;
  onClose: () => void;
}

const STEP_LABELS: Record<string, string> = {
  bigquery: "BigQuery Insert",
  speaker_id: "Speaker Identification",
  vector_store: "Vector Store Upload",
  gcs_download: "GCS Download",
};

export function StepDetailDrawer({ stepName, stepData, onClose }: StepDetailDrawerProps) {
  const [logOpen, setLogOpen] = useState(false);

  if (!stepData) return null;
  const log: string[] = stepData.log || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        className="relative w-[420px] bg-white shadow-xl h-full overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b px-4 py-3 flex items-center justify-between">
          <h3 className="font-semibold text-sm">{STEP_LABELS[stepName] || stepName}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-sm">
          {/* Status */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Status:</span>
            <StatusBadge status={stepData.status} />
          </div>

          {stepData.timestamp && (
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Time:</span>
              <span>{new Date(stepData.timestamp).toLocaleString()}</span>
            </div>
          )}

          {stepData.error && (
            <div className="bg-red-50 border border-red-200 rounded p-3">
              <span className="text-red-700 font-medium">Error: </span>
              <span className="text-red-600">{stepData.error}</span>
            </div>
          )}

          {/* BigQuery details */}
          {stepName === "bigquery" && stepData.status === "complete" && (
            <>
              <DetailRow label="Tables" value={(stepData.tables || []).join(", ")} />
              <DetailRow label="Segments" value={stepData.segment_count} />
            </>
          )}

          {/* Speaker ID details */}
          {stepName === "speaker_id" && stepData.status === "complete" && (
            <>
              <div>
                <span className="text-gray-500 block mb-1">Claude (Pass 1):</span>
                <div className="bg-gray-50 rounded p-2 font-mono text-xs">
                  {stepData.claude_pass || "—"}
                </div>
              </div>
              <div>
                <span className="text-gray-500 block mb-1">GPT (Pass 2):</span>
                <div className="bg-gray-50 rounded p-2 font-mono text-xs">
                  {stepData.gpt_pass || "—"}
                </div>
              </div>
              <div>
                <span className="text-gray-500 block mb-1">Final Speakers:</span>
                <div className="bg-green-50 border border-green-200 rounded p-2 font-medium">
                  {stepData.final || "—"}
                </div>
              </div>
            </>
          )}

          {/* Vector store details */}
          {stepName === "vector_store" && stepData.status === "complete" && (
            <>
              <DetailRow label="Chunks uploaded" value={stepData.chunks_uploaded} />
              <div>
                <span className="text-gray-500 block mb-1">Speakers indexed:</span>
                <div className="flex flex-wrap gap-1">
                  {(stepData.speakers_indexed || []).map((s: string, i: number) => (
                    <span key={i} className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* GCS download details */}
          {stepName === "gcs_download" && stepData.status === "complete" && (
            <>
              <DetailRow label="Execution ID" value={stepData.execution_id} />
              <DetailRow label="Video ID" value={stepData.video_id} />
            </>
          )}

          {/* Collapsible log pane */}
          {log.length > 0 && (
            <div className="border-t pt-3 mt-3">
              <button
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 font-medium"
                onClick={() => setLogOpen(!logOpen)}
              >
                {logOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                View Log ({log.length} entries)
              </button>
              {logOpen && (
                <div className="mt-2 bg-gray-900 text-gray-300 rounded p-3 max-h-[300px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                  {log.map((line, i) => (
                    <div key={i} className={line.includes("FAILED") ? "text-red-400" : line.includes("Complete") ? "text-green-400" : ""}>
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    complete: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    skipped: "bg-gray-100 text-gray-500",
    pending: "bg-gray-100 text-gray-500",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || colors.pending}`}>
      {status}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: any }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-500">{label}:</span>
      <span className="font-mono text-xs">{String(value ?? "—")}</span>
    </div>
  );
}
