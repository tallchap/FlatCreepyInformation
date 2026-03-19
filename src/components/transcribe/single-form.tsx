"use client";

import { useTranscriptHistory } from "@/components/transcribe/utils/hooks/useTranscriptHistory";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Loader } from "../loader";
import { BulkForm } from "./bulk-form";
import { singleExtract } from "./utils/actions";

export function SingleForm() {
  const [state, action, isPending] = useActionState(singleExtract, null);
  const { addTranscript, updateTranscript } = useTranscriptHistory();
  const processedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!state || state.error) {
      if (state?.error) toast.error(state.error);
      return;
    }

    // Prevent duplicate processing on re-renders
    const stateKey = `${state.youtubeLink}-${state.status}`;
    if (processedRef.current === stateKey) return;
    processedRef.current = stateKey;

    if (state.status === "vectorizing") {
      // Add entry with vectorizing status, then kick off vector upload
      const item = addTranscript({
        videoTitle: state.videoTitle,
        youtubeLink: state.youtubeLink,
        googleDocUrl: state.googleDocUrl,
        status: "vectorizing",
      });

      fetch("/api/vector-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.vectorData),
      })
        .then(() => {
          updateTranscript(item.id, { status: "success" });
        })
        .catch((err) => {
          console.error("Vector upload failed:", err);
          // Still mark success — vector upload is non-blocking
          updateTranscript(item.id, { status: "success" });
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
        <form className="flex flex-col gap-6" action={action}>
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
