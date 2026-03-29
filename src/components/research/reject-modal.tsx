"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const QUICK_REASONS = [
  "Speaker not actually in video",
  "Clip/compilation, not full interview",
  "Duplicate of another result",
  "Wrong person with same name",
  "Low quality / not worth transcribing",
];

export function RejectModal({
  candidate,
  onClose,
  onConfirm,
}: {
  candidate: { video_id: string; title: string; channel: string };
  onClose: () => void;
  onConfirm: (reason: string, rule?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [saveAsRule, setSaveAsRule] = useState(false);
  const [rulePattern, setRulePattern] = useState("");
  const [ruleType, setRuleType] = useState<"channel" | "title">("channel");

  function handleReasonSelect(r: string) {
    setReason(r);
    // Auto-suggest rule pattern based on reason
    if (r === "Clip/compilation, not full interview") {
      setRulePattern(candidate.channel);
      setRuleType("channel");
    } else if (r === "Speaker not actually in video") {
      setRuleType("channel");
      setRulePattern(candidate.channel);
    }
  }

  function handleConfirm() {
    const finalReason = reason || customReason || "No reason given";
    const rule = saveAsRule && rulePattern
      ? `${ruleType}:${rulePattern}`
      : undefined;
    onConfirm(finalReason, rule);
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject Video</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-gray-600 truncate">{candidate.title}</p>
          <p className="text-xs text-gray-400">{candidate.channel}</p>

          {/* Quick reasons */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Why reject?</label>
            {QUICK_REASONS.map((r) => (
              <button
                key={r}
                className={`block w-full text-left px-3 py-1.5 text-sm rounded border ${
                  reason === r
                    ? "border-red-500 bg-red-50 text-red-700"
                    : "border-gray-200 hover:bg-gray-50"
                }`}
                onClick={() => handleReasonSelect(r)}
              >
                {r}
              </button>
            ))}
          </div>

          {/* Custom reason */}
          <div>
            <label className="text-sm font-medium">Or type a custom reason:</label>
            <input
              type="text"
              className="w-full mt-1 px-3 py-1.5 text-sm border rounded"
              placeholder="Custom reason..."
              value={customReason}
              onChange={(e) => {
                setCustomReason(e.target.value);
                setReason("");
              }}
            />
          </div>

          {/* Save as rule */}
          <div className="border-t pt-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={saveAsRule}
                onChange={(e) => setSaveAsRule(e.target.checked)}
                className="rounded"
              />
              Save as rule (apply to future searches)
            </label>

            {saveAsRule && (
              <div className="mt-2 space-y-2 ml-6">
                <div className="flex gap-2">
                  <select
                    className="text-sm border rounded px-2 py-1"
                    value={ruleType}
                    onChange={(e) => setRuleType(e.target.value as "channel" | "title")}
                  >
                    <option value="channel">Reject channel</option>
                    <option value="title">Reject title pattern</option>
                  </select>
                </div>
                <input
                  type="text"
                  className="w-full px-3 py-1.5 text-sm border rounded font-mono"
                  placeholder={ruleType === "channel" ? "Channel name" : "Regex pattern"}
                  value={rulePattern}
                  onChange={(e) => setRulePattern(e.target.value)}
                />
                <p className="text-xs text-gray-400">
                  {ruleType === "channel"
                    ? "Videos from this channel will be auto-rejected in future searches."
                    : "Videos matching this title pattern (regex) will be auto-rejected."}
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <button
            className="px-4 py-2 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700"
            onClick={handleConfirm}
          >
            Reject
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
