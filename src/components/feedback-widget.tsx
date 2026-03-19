"use client";

import { useState, useCallback, useRef, useEffect } from "react";
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
import { Upload, X } from "lucide-react";

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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [email, setEmail] = useState("");
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const attachImage = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    setScreenshotFile(file);
    setScreenshotPreview(URL.createObjectURL(file));
  }, []);

  const removeScreenshot = useCallback(() => {
    if (screenshotPreview) URL.revokeObjectURL(screenshotPreview);
    setScreenshotFile(null);
    setScreenshotPreview(null);
  }, [screenshotPreview]);

  // Listen for paste events when dialog is open
  useEffect(() => {
    if (!open) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) attachImage(file);
          return;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [open, attachImage]);

  const handleClose = () => {
    setOpen(false);
    setFeedbackText("");
    setEmail("");
    removeScreenshot();
  };

  const handleSubmit = async () => {
    if (!feedbackText.trim() || !email.trim()) return;
    setSubmitting(true);
    try {
      let screenshotBase64: string | null = null;
      if (screenshotFile) {
        screenshotBase64 = await fileToBase64(screenshotFile);
      }
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: feedbackText.trim(),
          email: email.trim(),
          screenshotBase64,
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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) attachImage(file);
    },
    [attachImage],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) attachImage(file);
      e.target.value = "";
    },
    [attachImage],
  );

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(true)}
        className="group fixed bottom-4 left-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-gray-300 bg-white shadow-lg transition-all hover:scale-[1.08] hover:shadow-xl"
        aria-label="Report a bug"
      >
        <CrackedEggIcon className="h-7 w-7" />
        <span className="pointer-events-none absolute bottom-14 left-0 hidden whitespace-nowrap rounded-md bg-gray-800 px-3 py-1.5 text-xs text-white group-hover:block">
          Report a bug
        </span>
      </button>

      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
        <DialogContent ref={dialogRef} className="max-h-[90vh] overflow-y-auto sm:max-w-[500px]">
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

            {/* Screenshot: paste / drag-and-drop / browse */}
            <div className="space-y-2">
              <Label>Screenshot (optional)</Label>

              {screenshotPreview ? (
                /* Preview attached image */
                <div className="relative">
                  <button
                    onClick={removeScreenshot}
                    className="absolute -right-2 -top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-gray-800 text-white shadow-md hover:bg-gray-700"
                    aria-label="Remove screenshot"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <div
                    className="relative overflow-hidden rounded-sm border border-gray-300 bg-white"
                    style={{
                      boxShadow: "2px 2px 6px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)",
                      transform: "rotate(-0.5deg)",
                      maxHeight: "200px",
                    }}
                  >
                    <div
                      className="absolute right-0 top-0 z-10 h-5 w-5 rounded-bl"
                      style={{ background: "linear-gradient(135deg, #f3f4f6 50%, #d1d5db 50%)" }}
                    />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={screenshotPreview}
                      alt="Attached screenshot"
                      className="w-full"
                    />
                    <div
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
                      style={{ background: "linear-gradient(transparent, white)" }}
                    />
                  </div>
                </div>
              ) : (
                /* Drop zone */
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
                    dragOver
                      ? "border-[#4a7c2e] bg-green-50"
                      : "border-gray-300 hover:border-gray-400 hover:bg-gray-50"
                  }`}
                >
                  <Upload className="h-5 w-5 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Paste screenshot <kbd className="rounded border border-gray-200 bg-gray-100 px-1 py-0.5 text-xs font-medium">&#8984;V</kbd> or drag image here
                  </p>
                  <p className="text-xs text-muted-foreground">or click to browse</p>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
              />
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
