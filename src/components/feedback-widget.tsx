"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Paperclip } from "lucide-react";

function CrackedEggIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 60 76"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M30 4C19 4 7 24 7 46C7 60 17 72 30 72C43 72 53 60 53 46C53 24 41 4 30 4Z"
        fill="white"
        stroke="#1e1b4b"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 40 L18 36 L24 42 L30 36 L36 42 L42 36 L49 40"
        stroke="#1e1b4b"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M30 36 L31 30 L29 24 L30 18"
        stroke="#1e1b4b"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M30 18 L27 13" stroke="#1e1b4b" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M30 18 L33 14" stroke="#1e1b4b" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M29 24 L25 22" stroke="#1e1b4b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M31 30 L35 28" stroke="#1e1b4b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M14 54 Q16 58, 14 62" stroke="#1e1b4b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M44 52 Q46 56, 44 60" stroke="#1e1b4b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [email, setEmail] = useState("");
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const handleOpen = useCallback(async () => {
    if (includeScreenshot) {
      setCapturing(true);
      try {
        const html2canvas = (await import("html2canvas")).default;
        const canvas = await html2canvas(document.body, { scale: 1 });
        setScreenshotDataUrl(canvas.toDataURL("image/jpeg", 0.7));
      } catch (e) {
        console.error("Screenshot capture failed:", e);
        setScreenshotDataUrl(null);
      }
      setCapturing(false);
    }
    setOpen(true);
  }, [includeScreenshot]);

  const handleClose = () => {
    setOpen(false);
    setFeedbackText("");
    setEmail("");
    setScreenshotDataUrl(null);
  };

  const handleSubmit = async () => {
    if (!feedbackText.trim() || !email.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: feedbackText.trim(),
          email: email.trim(),
          screenshotBase64: includeScreenshot ? screenshotDataUrl : null,
          pageUrl: window.location.href,
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) throw new Error("Failed to send feedback");
      toast.success("Thanks for your feedback!");
      handleClose();
    } catch {
      toast.error("Failed to send feedback. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {/* Floating button */}
      <button
        onClick={handleOpen}
        disabled={capturing}
        className="group fixed bottom-4 left-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-gray-300 bg-white shadow-lg transition-all hover:scale-[1.08] hover:shadow-xl disabled:opacity-70"
        aria-label="Report a bug"
      >
        <CrackedEggIcon className="h-7 w-7" />
        {/* Tooltip */}
        <span className="pointer-events-none absolute bottom-14 left-0 hidden whitespace-nowrap rounded-md bg-gray-800 px-3 py-1.5 text-xs text-white group-hover:block">
          Report a bug
        </span>
      </button>

      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CrackedEggIcon className="h-6 w-6" />
              Feedback
            </DialogTitle>
            <DialogDescription className="sr-only">
              Report a bug or issue
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Feedback text */}
            <div className="space-y-1.5">
              <Label htmlFor="feedback-text">
                What&apos;s not working? <span className="text-red-500">*</span>
              </Label>
              <Textarea
                id="feedback-text"
                placeholder="Describe the issue you're experiencing..."
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                className="min-h-20 resize-y"
              />
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <Label htmlFor="feedback-email">
                Email <span className="text-red-500">*</span>
              </Label>
              <p className="text-xs text-muted-foreground">
                We&apos;ll notify you when it&apos;s fixed
              </p>
              <Input
                id="feedback-email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            {/* Screenshot attachment */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                  Attached screenshot
                </span>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={includeScreenshot}
                    onChange={(e) => setIncludeScreenshot(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[#4a7c2e]"
                  />
                  Include
                </label>
              </div>

              {includeScreenshot && screenshotDataUrl && (
                <div
                  className="relative overflow-hidden rounded-sm border border-gray-300 bg-white"
                  style={{
                    boxShadow: "2px 2px 6px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)",
                    transform: "rotate(-0.5deg)",
                    maxHeight: "200px",
                  }}
                >
                  {/* Dog-ear corner */}
                  <div
                    className="absolute right-0 top-0 z-10 h-5 w-5 rounded-bl"
                    style={{ background: "linear-gradient(135deg, #f3f4f6 50%, #d1d5db 50%)" }}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={screenshotDataUrl}
                    alt="Screenshot of current page"
                    className="w-full"
                  />
                  {/* Fade out at bottom */}
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
                    style={{ background: "linear-gradient(transparent, white)" }}
                  />
                </div>
              )}

              {includeScreenshot && !screenshotDataUrl && (
                <p className="text-xs text-muted-foreground italic">
                  Screenshot will be captured when you open this dialog.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || !feedbackText.trim() || !email.trim()}
              className="bg-[#4a7c2e] text-white hover:bg-[#3d6a25]"
            >
              {submitting ? "Sending..." : "Send Feedback"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
