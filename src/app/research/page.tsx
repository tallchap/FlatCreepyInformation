"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { CandidateTable } from "@/components/research/candidate-table";
import { DetailDrawer } from "@/components/research/detail-drawer";
import { RejectModal } from "@/components/research/reject-modal";
import { StepDetailDrawer } from "@/components/research/step-detail-drawer";
import { toast } from "sonner";

interface Candidate {
  run_id: string;
  video_id: string;
  title: string;
  channel: string;
  channel_id: string;
  duration_seconds: number;
  published_at: string;
  description: string;
  thumbnail_url: string;
  confidence: number;
  reasoning: string;
  red_flags: string[];
  category: string;
  status: string;
  reject_reason: string | null;
  processing_status: string | null;
  processing_error: string | null;
  processing_step: string | null;
  processing_steps_json: string | null;
  matched_rules: string[];
}

interface Run {
  run_id: string;
  speaker: string;
  date_after: string | null;
  date_before: string | null;
  total_raw: number;
  total_scored: number;
  created_at: { value: string };
}

export default function ResearchPage() {
  return (
    <Suspense fallback={<div className="text-center py-20 text-gray-400">Loading...</div>}>
      <ResearchPageInner />
    </Suspense>
  );
}

function ResearchPageInner() {
  const searchParams = useSearchParams();
  const initialRunId = searchParams.get("runId");

  const [runs, setRuns] = useState<Run[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [rejectCandidate, setRejectCandidate] = useState<Candidate | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [stepDrawer, setStepDrawer] = useState<{ step: string; data: any } | null>(null);

  // Load runs list
  useEffect(() => {
    fetch("/api/research/candidates")
      .then((r) => r.json())
      .then((d) => setRuns(d.runs || []))
      .catch((e) => toast.error("Failed to load runs: " + e.message));
  }, []);

  // Load candidates when run changes
  const loadCandidates = useCallback(async (runId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/research/candidates?runId=${runId}`);
      const data = await res.json();
      setCandidates(data.candidates || []);
    } catch (e: any) {
      toast.error("Failed to load candidates: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedRunId) loadCandidates(selectedRunId);
  }, [selectedRunId, loadCandidates]);

  // Auto-select first run if none specified
  useEffect(() => {
    if (!selectedRunId && runs.length > 0) {
      setSelectedRunId(runs[0].run_id);
    }
  }, [runs, selectedRunId]);

  const currentRun = runs.find((r) => r.run_id === selectedRunId);

  // Filter candidates (handles both old status column and new satellite rejection table)
  const filtered = statusFilter === "all"
    ? candidates
    : statusFilter === "pending"
    ? candidates.filter((c) => c.status === "pending" && !(c as any).rejection_type)
    : statusFilter === "rejected"
    ? candidates.filter((c) => c.status?.startsWith("rejected") || (c as any).rejection_type)
    : candidates.filter((c) => c.status === statusFilter);

  // Vet a candidate
  async function vetCandidate(
    videoId: string,
    action: "approved" | "rejected" | "skipped",
    rejectReason?: string,
    ruleGenerated?: string
  ) {
    try {
      await fetch("/api/research/vet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: selectedRunId,
          videoId,
          action,
          rejectReason,
          ruleGenerated,
        }),
      });
      setCandidates((prev) =>
        prev.map((c) =>
          c.video_id === videoId
            ? { ...c, status: action, reject_reason: rejectReason || null }
            : c
        )
      );
      toast.success(`${action}: ${videoId}`);
    } catch (e: any) {
      toast.error("Failed to vet: " + e.message);
    }
  }

  // Batch vet — single API call
  async function batchVet(action: "approved" | "rejected" | "skipped") {
    if (selectedIds.size === 0) return;
    try {
      await fetch("/api/research/vet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: selectedRunId,
          videoIds: [...selectedIds],
          action,
        }),
      });
      setCandidates((prev) =>
        prev.map((c) =>
          selectedIds.has(c.video_id) ? { ...c, status: action } : c
        )
      );
      toast.success(`${action} ${selectedIds.size} videos`);
      setSelectedIds(new Set());
    } catch (e: any) {
      toast.error("Batch vet failed: " + e.message);
    }
  }

  // Approve & Process — one button
  async function approveAndProcess() {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];

    // 1. Bulk approve
    try {
      await fetch("/api/research/vet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: selectedRunId, videoIds: ids, action: "approved" }),
      });
    } catch (e: any) {
      toast.error("Approve failed: " + e.message);
      return;
    }

    // 2. Update UI + mark queued
    setCandidates((prev) =>
      prev.map((c) =>
        ids.includes(c.video_id) ? { ...c, status: "approved", processing_status: "queued" } : c
      )
    );
    setSelectedIds(new Set());

    // 3. Fire off processing
    try {
      const res = await fetch("/api/research/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: selectedRunId,
          videoIds: ids,
          speaker: currentRun?.speaker || "",
        }),
      });
      const data = await res.json();
      toast.info(`Approved & queued ${data.queued} videos for processing`);
      setProcessing(true);
      startPolling();
    } catch (e: any) {
      toast.error("Process failed: " + e.message);
    }
  }

  // Process approved videos — fire and forget, poll for status
  async function processApproved() {
    const approved = candidates.filter((c) => c.status === "approved" && !c.processing_status);
    if (approved.length === 0) {
      toast.error("No approved videos to process");
      return;
    }

    // Mark as queued locally
    setCandidates((prev) =>
      prev.map((c) =>
        c.status === "approved" && !c.processing_status
          ? { ...c, processing_status: "queued" }
          : c
      )
    );

    try {
      const res = await fetch("/api/research/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: selectedRunId,
          videoIds: approved.map((c) => c.video_id),
          speaker: currentRun?.speaker || "",
        }),
      });
      const data = await res.json();
      toast.info(`Queued ${data.queued} videos for processing`);
      setProcessing(true);
      startPolling();
    } catch (e: any) {
      toast.error("Processing failed: " + e.message);
      setProcessing(false);
    }
  }

  // Poll for processing status updates — only updates if user is still on that run
  function startPolling() {
    const pollingRunId = selectedRunId;
    const interval = setInterval(async () => {
      if (!pollingRunId) { clearInterval(interval); return; }
      try {
        const res = await fetch(`/api/research/candidates?runId=${pollingRunId}`);
        const data = await res.json();
        if (data.candidates) {
          // Only update UI if user is still viewing this run
          setCandidates((prev) => {
            if (prev.length > 0 && prev[0].run_id !== pollingRunId) return prev;
            return data.candidates;
          });
          const queued = data.candidates.filter((c: any) => c.processing_status === "queued" || c.processing_status === "processing");
          if (queued.length === 0) {
            clearInterval(interval);
            setProcessing(false);
            const complete = data.candidates.filter((c: any) => c.processing_status === "complete").length;
            const failed = data.candidates.filter((c: any) => c.processing_status === "failed").length;
            toast.success(`Done: ${complete} succeeded, ${failed} failed`);
          }
        }
      } catch {}
    }, 5000);
  }

  const approvedCount = candidates.filter(
    (c) => c.status === "approved" && !c.processing_status
  ).length;

  const failedCount = candidates.filter(
    (c) => c.processing_status === "failed"
  ).length;

  async function retryFailed() {
    const failed = candidates.filter((c) => c.processing_status === "failed");
    if (failed.length === 0) return;

    setCandidates((prev) =>
      prev.map((c) =>
        c.processing_status === "failed" ? { ...c, processing_status: "queued", processing_error: null } : c
      )
    );

    try {
      const res = await fetch("/api/research/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: selectedRunId,
          videoIds: failed.map((c) => c.video_id),
          speaker: currentRun?.speaker || "",
        }),
      });
      const data = await res.json();
      toast.info(`Queued ${data.queued} failed videos for retry`);
      setProcessing(true);
      startPolling();
    } catch (e: any) {
      toast.error("Retry failed: " + e.message);
      setProcessing(false);
    }
  }

  return (
    <div className="max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Video Research</h1>
          {currentRun && (
            <p className="text-sm text-gray-500">
              {currentRun.speaker} | {currentRun.total_scored} candidates |{" "}
              {new Date(currentRun.created_at?.value || "").toLocaleDateString()}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Run selector */}
          <select
            className="text-sm border rounded px-2 py-1.5 bg-white"
            value={selectedRunId || ""}
            onChange={(e) => setSelectedRunId(e.target.value)}
          >
            <option value="">Select a run...</option>
            {runs.map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {r.speaker} ({r.total_scored}) —{" "}
                {new Date(r.created_at?.value || "").toLocaleDateString()}
              </option>
            ))}
          </select>

          {/* Status filter */}
          <select
            className="text-sm border rounded px-2 py-1.5 bg-white"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="skipped">Skipped</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 mb-3">
        {selectedIds.size > 0 && (
          <>
            <span className="text-sm text-gray-500">{selectedIds.size} selected</span>
            <button
              className="px-3 py-1 text-sm bg-green-700 text-white rounded hover:bg-green-800 font-medium"
              onClick={approveAndProcess}
              disabled={processing}
            >
              {processing ? "Processing..." : `Approve & Process ${selectedIds.size}`}
            </button>
            <button
              className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700"
              onClick={() => batchVet("approved")}
            >
              Approve only
            </button>
            <button
              className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
              onClick={() => batchVet("rejected")}
            >
              Reject selected
            </button>
            <button
              className="px-3 py-1 text-sm bg-gray-400 text-white rounded hover:bg-gray-500"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear
            </button>
          </>
        )}

        {failedCount > 0 && (
          <button
            className="px-4 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            onClick={retryFailed}
            disabled={processing}
          >
            {processing ? "Retrying..." : `Retry ${failedCount} failed`}
          </button>
        )}

        {approvedCount > 0 && (
          <button
            className="ml-auto px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            onClick={processApproved}
            disabled={processing}
          >
            {processing
              ? "Processing..."
              : `Process ${approvedCount} approved video${approvedCount > 1 ? "s" : ""}`}
          </button>
        )}
      </div>

      {/* Processing summary bar */}
      {(() => {
        const complete = candidates.filter((c) => c.processing_status === "complete").length;
        const inProgress = candidates.filter((c) => c.processing_status === "processing").length;
        const queued = candidates.filter((c) => c.processing_status === "queued").length;
        const pFailed = candidates.filter((c) => c.processing_status === "failed").length;
        if (complete + inProgress + queued + pFailed === 0) return null;
        return (
          <div className="mb-3 px-3 py-2 bg-gray-50 rounded text-xs text-gray-600 flex gap-4">
            {complete > 0 && <span className="text-green-700 font-medium">{complete} complete</span>}
            {inProgress > 0 && <span className="text-blue-700 font-medium">{inProgress} in progress</span>}
            {queued > 0 && <span className="text-gray-500">{queued} queued</span>}
            {pFailed > 0 && <span className="text-red-700 font-medium">{pFailed} failed</span>}
          </div>
        );
      })()}

      {/* Main table */}
      {loading ? (
        <div className="text-center py-20 text-gray-400">Loading candidates...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-400 text-lg">
            {candidates.length === 0
              ? "No candidates found. Run a search first."
              : `No ${statusFilter} candidates.`}
          </p>
          {candidates.length === 0 && (
            <p className="text-gray-400 text-sm mt-2">
              node scripts/video-research/search.mjs &quot;Speaker Name&quot; --after 2025-01-01 --before 2025-12-31
            </p>
          )}
        </div>
      ) : (
        <CandidateTable
          candidates={filtered}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onRowClick={setSelectedCandidate}
          onApprove={(id) => vetCandidate(id, "approved")}
          onReject={(c) => setRejectCandidate(c)}
          onSkip={(id) => vetCandidate(id, "skipped")}
          onStepClick={(step, data) => setStepDrawer({ step, data })}
        />
      )}

      {/* Detail drawer */}
      {selectedCandidate && (
        <DetailDrawer
          candidate={selectedCandidate}
          onClose={() => setSelectedCandidate(null)}
          onApprove={() => {
            vetCandidate(selectedCandidate.video_id, "approved");
            setSelectedCandidate(null);
          }}
          onReject={() => {
            setRejectCandidate(selectedCandidate);
            setSelectedCandidate(null);
          }}
          onSkip={() => {
            vetCandidate(selectedCandidate.video_id, "skipped");
            setSelectedCandidate(null);
          }}
        />
      )}

      {/* Step detail drawer */}
      {stepDrawer && (
        <StepDetailDrawer
          stepName={stepDrawer.step}
          stepData={stepDrawer.data}
          onClose={() => setStepDrawer(null)}
        />
      )}

      {/* Reject modal */}
      {rejectCandidate && (
        <RejectModal
          candidate={rejectCandidate}
          onClose={() => setRejectCandidate(null)}
          onConfirm={(reason, rule) => {
            vetCandidate(rejectCandidate.video_id, "rejected", reason, rule);
            setRejectCandidate(null);
          }}
        />
      )}
    </div>
  );
}
