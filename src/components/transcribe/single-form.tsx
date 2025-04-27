"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useActionState } from "react";
import { singleExtract } from "./utils/actions";
import { Loader } from "../loader";
import { useTranscriptHistory } from "@/components/transcribe/utils/hooks/useTranscriptHistory";
import { useEffect } from "react";
import { toast } from "sonner";

export function SingleForm() {
  const [state, action, isPending] = useActionState(singleExtract, null);
  const { addTranscript } = useTranscriptHistory();

  useEffect(() => {
    // When we get a successful response, store it in localStorage
    if (state && !state.error) {
      addTranscript({
        videoTitle: state?.videoTitle,
        youtubeLink: state?.youtubeLink,
        googleDocUrl: state?.googleDocUrl,
        status: state?.status as "success" | "failed",
      });
    }
    if (state && state.error) {
      toast.error(state.error);
    }
  }, [state]);

  return (
    <Card>
      <CardContent>
        <form className="flex flex-col gap-6" action={action}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="url">YouTube URL</Label>
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
          <div className="flex justify-between items-center gap-2 rounded-lg border p-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="store_in_bigquery">Store in BigQuery</Label>
              <p className="text-sm text-gray-500">
                Save transcript data to BigQuery
              </p>
            </div>
            <Switch id="store_in_bigquery" name="store_in_bigquery" />
          </div>
          <Button type="submit">Extract Metadata & Transcript</Button>
        </form>
      </CardContent>
      {isPending && <Loader className="mx-auto" />}
    </Card>
  );
}
