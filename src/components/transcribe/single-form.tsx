"use client";

import { useTranscriptHistory } from "@/components/transcribe/utils/hooks/useTranscriptHistory";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Loader } from "../loader";
import { BulkForm } from "./bulk-form";
import { singleExtract } from "./utils/actions";

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
          <div className="flex justify-between items-center gap-2 rounded-lg border p-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="store_in_bigquery">Store in Database</Label>
              <p className="text-sm text-gray-500">
                Save transcript to searchable database
              </p>
            </div>
            <Switch
              id="store_in_bigquery"
              name="store_in_bigquery"
              defaultChecked={true}
            />
          </div>
          <Button type="submit">Process Video</Button>
        </form>
      </CardContent>
      {isPending && <Loader className="mx-auto" />}
    </Card>
  );
}
