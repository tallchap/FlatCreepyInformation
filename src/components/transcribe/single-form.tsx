"use client";

import { useTranscriptHistory } from "@/components/transcribe/utils/hooks/useTranscriptHistory";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActionState, useEffect, useRef, FormEvent } from "react";
import { toast } from "sonner";
import { Loader } from "../loader";
import { BulkForm } from "./bulk-form";
import { singleExtract } from "./utils/actions";
import { useDebugLog } from "./utils/hooks/useDebugLog";

function extractVideoId(url: string): string | null {
  if (!url) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

export function SingleForm() {
  const [state, action, isPending] = useActionState(singleExtract, null);
  const { addTranscript, updateTranscript } = useTranscriptHistory();
  const { addEntry } = useDebugLog();
  const processedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!state) return;

    if (state.error) {
      toast.error(state.error);
      addEntry({
        step: "validation/metadata",
        status: "error",
        message: state.error,
      });
      return;
    }

    // Prevent duplicate processing on re-renders
    const stateKey = `${state.youtubeLink}-${state.status}`;
    if (processedRef.current === stateKey) return;
    processedRef.current = stateKey;

    if (state.status === "failed") {
      addTranscript({
        videoTitle: state.videoTitle,
        youtubeLink: state.youtubeLink,
        googleDocUrl: state.googleDocUrl,
        status: "failed",
        failedStep: state.failedStep,
        errorMessage: state.errorMessage,
      });
      addEntry({
        step: state.failedStep || "unknown",
        status: "error",
        message: state.errorMessage || "Unknown error",
        videoTitle: state.videoTitle,
      });
    } else if (state.status === "vectorizing") {
      const item = addTranscript({
        videoTitle: state.videoTitle,
        youtubeLink: state.youtubeLink,
        googleDocUrl: state.googleDocUrl,
        status: "vectorizing",
      });

      addEntry({
        step: "vectorizing",
        status: "info",
        message: "BigQuery done, uploading to vector store...",
        videoTitle: state.videoTitle,
      });

      fetch("/api/vector-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.vectorData),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          updateTranscript(item.id, { status: "success" });
          addEntry({
            step: "vector-upload",
            status: "success",
            message: "Vector store upload complete",
            videoTitle: state.videoTitle,
          });
        })
        .catch((err) => {
          console.error("Vector upload failed:", err);
          updateTranscript(item.id, { status: "success" });
          addEntry({
            step: "vector-upload",
            status: "error",
            message: `Vector upload failed: ${err.message} (non-blocking)`,
            videoTitle: state.videoTitle,
          });
        });
    } else {
      addTranscript({
        videoTitle: state.videoTitle,
        youtubeLink: state.youtubeLink,
        googleDocUrl: state.googleDocUrl,
        status: state.status as "success" | "failed",
      });
    }
  }, [state]);

  return (
    <Card>
      <CardContent>
        <form
          className="flex flex-col gap-6"
          action={action}
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            const url = (e.currentTarget.elements.namedItem("url") as HTMLInputElement | null)?.value || "";
            const videoId = extractVideoId(url);
            if (!videoId) return;
            fetch("/api/trigger-bunny", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ videoId }),
            }).catch(() => {});
            addEntry({
              step: "bunny-download",
              status: "info",
              message: `Bunny fetch triggered at submit (videoId=${videoId})`,
            });
          }}
        >
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-end gap-2">
              <Label htmlFor="url">YouTube URL</Label>
              <BulkForm />
            </div>
            <Input
              id="url"
              name="url"
              placeholder="https://www.youtube.com/watch?v=..."
              required
            />
            <span className="text-sm text-gray-500">
              Enter a valid YouTube video URL
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="speaker">Speaker Name</Label>
            <Input
              id="speaker"
              name="speaker"
              placeholder="John Doe"
              required
            />
            <span className="text-sm text-gray-500">
              Enter the name of the main speaker (or most relevant person)
            </span>
          </div>
          <input type="hidden" name="store_in_bigquery" value="on" />
          <Button type="submit">Process Video</Button>
        </form>
      </CardContent>
      {isPending && <Loader className="mx-auto" />}
    </Card>
  );
}
