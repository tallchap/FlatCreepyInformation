"use client";

import { X, CheckCircle2, XCircle, SkipForward, ExternalLink } from "lucide-react";

interface Candidate {
  video_id: string;
  title: string;
  channel: string;
  duration_seconds: number;
  published_at: string;
  description: string;
  confidence: number;
  reasoning: string;
  red_flags: string[];
  category: string;
  status: string;
  processing_status: string | null;
  processing_error: string | null;
  matched_rules: string[];
}

function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function DetailDrawer({
  candidate: c,
  onClose,
  onApprove,
  onReject,
  onSkip,
}: {
  candidate: Candidate;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Drawer */}
      <div className="relative w-[600px] max-w-[90vw] bg-white shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between z-10">
          <h2 className="font-semibold truncate pr-4">{c.title}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* YouTube embed */}
          <div className="aspect-video bg-black rounded overflow-hidden">
            <iframe
              src={`https://www.youtube.com/embed/${c.video_id}`}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-500">Channel:</span>{" "}
              <span className="font-medium">{c.channel}</span>
            </div>
            <div>
              <span className="text-gray-500">Duration:</span>{" "}
              <span className="font-mono">{formatDuration(c.duration_seconds)}</span>
            </div>
            <div>
              <span className="text-gray-500">Published:</span> {c.published_at}
            </div>
            <div>
              <span className="text-gray-500">Category:</span>{" "}
              <span className="capitalize">{c.category}</span>
            </div>
            <div>
              <span className="text-gray-500">Confidence:</span>{" "}
              <span className="font-bold">{c.confidence}</span>
            </div>
            <div>
              <span className="text-gray-500">Status:</span>{" "}
              <span className="capitalize">{c.processing_status || c.status}</span>
            </div>
          </div>

          {/* AI Reasoning */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">AI Reasoning</h3>
            <p className="text-sm text-gray-600 bg-gray-50 rounded p-2">{c.reasoning}</p>
          </div>

          {/* Red flags */}
          {c.red_flags?.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-red-600 mb-1">Red Flags</h3>
              <ul className="text-sm text-red-600 list-disc list-inside">
                {c.red_flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Matched rules */}
          {c.matched_rules?.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-1">Matched Rules</h3>
              <div className="flex flex-wrap gap-1">
                {c.matched_rules.map((r, i) => (
                  <span key={i} className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                    {r}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Description</h3>
            <p className="text-sm text-gray-600 whitespace-pre-line max-h-48 overflow-y-auto">
              {c.description}
            </p>
          </div>

          {/* Processing error */}
          {c.processing_error && (
            <div className="bg-red-50 border border-red-200 rounded p-3">
              <h3 className="text-sm font-semibold text-red-700 mb-1">Processing Error</h3>
              <p className="text-sm text-red-600">{c.processing_error}</p>
            </div>
          )}
        </div>

        {/* Action buttons */}
        {c.status === "pending" && (
          <div className="sticky bottom-0 bg-white border-t p-4 flex items-center gap-2">
            <button
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-green-600 text-white rounded hover:bg-green-700"
              onClick={onApprove}
            >
              <CheckCircle2 className="w-4 h-4" /> Approve
            </button>
            <button
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-red-600 text-white rounded hover:bg-red-700"
              onClick={onReject}
            >
              <XCircle className="w-4 h-4" /> Reject
            </button>
            <button
              className="flex items-center justify-center gap-2 py-2 px-4 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              onClick={onSkip}
            >
              <SkipForward className="w-4 h-4" /> Skip
            </button>
            <a
              href={`https://www.youtube.com/watch?v=${c.video_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-2 px-4 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
