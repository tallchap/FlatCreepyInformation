"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Input } from "../ui/input";
import { useRef, useState } from "react";
import papa from "papaparse";
import { toast } from "sonner";
import { singleExtract } from "./utils/actions";
import { useTranscriptHistory } from "./utils/hooks/useTranscriptHistory";
import { Progress } from "@/components/ui/progress";
export function BulkForm() {
  const [data, setData] = useState<[string, string][]>([]);
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [completedEntries, setCompletedEntries] = useState(0);
  const [totalEntries, setTotalEntries] = useState(0);
  const { addTranscript } = useTranscriptHistory();
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      papa.parse<string[]>(file, {
        header: false,
        skipEmptyLines: true,
        complete(results) {
          console.log(results.data);
          try {
            setData(results.data.map((row) => [row[0].trim(), row[1].trim()]));
          } catch (error) {
            toast.error("Error parsing CSV file");
            setData([]);
          }
        },
        error() {
          toast.error("Error parsing CSV file");
          setData([]);
        },
      });
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (data.length === 0) {
      toast.error("Please upload a CSV file");
      return;
    }

    setIsProcessing(true);
    setProgress(0);
    setEta("Calculating...");
    setCompletedEntries(0);
    setTotalEntries(data.length);

    const startTime = Date.now();
    let completed = 0;

    for (const entry of data) {
      const formData = new FormData();
      formData.append("url", entry[0]);
      formData.append("speaker", entry[1]);
      formData.append("store_in_bigquery", "on");
      formData.append("store_in_sheet", "on");

      const response = await singleExtract(null, formData);

      completed++;
      setCompletedEntries(completed);
      const currentProgress = Math.round((completed / data.length) * 100);
      setProgress(currentProgress);

      // Calculate ETA
      if (completed > 0) {
        const elapsedTime = Date.now() - startTime;
        const averageTimePerEntry = elapsedTime / completed;
        const remainingEntries = data.length - completed;
        const estimatedRemainingTime = remainingEntries * averageTimePerEntry;

        // Format the ETA
        if (estimatedRemainingTime > 0) {
          const minutes = Math.floor(estimatedRemainingTime / 60000);
          const seconds = Math.floor((estimatedRemainingTime % 60000) / 1000);
          setEta(`${minutes}m ${seconds}s remaining`);
        } else {
          setEta("Almost done...");
        }
      }

      if (response && !response.error) {
        addTranscript({
          videoTitle: response?.videoTitle,
          youtubeLink: response?.youtubeLink,
          googleDocUrl: response?.googleDocUrl,
          status: response?.status as "success" | "failed",
        });
      } else {
        toast.error(`Error processing ${entry[0]}`);
      }
    }

    setIsProcessing(false);
    setEta(null);
    toast.success("All entries processed");
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bulk Upload YouTube Videos</CardTitle>
        <CardDescription>
          Upload a CSV file with YouTube links and speaker names to process
          multiple videos at once. The format should be: YouTube URL, Speaker
          Name (one per line).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="csvFile">Upload CSV File</Label>
            <Input
              id="csvFile"
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              required
              ref={inputRef}
            />
            <span className="text-sm text-gray-500">
              Format: YouTube URL, Speaker Name (one per line)
            </span>
          </div>
          {data.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-2">
                Preview{" "}
                {data.length > 30
                  ? `(showing first 30 of ${data.length} entries)`
                  : `(${data.length} entries)`}
              </h3>
              <div className="bg-muted p-2 rounded-md max-h-40 overflow-y-auto text-sm">
                {data.slice(0, 30).map((entry, index) => (
                  <div
                    key={index}
                    className={`p-1 ${
                      index < data.slice(0, 30).length - 1
                        ? "border-b border-muted-foreground/20"
                        : ""
                    }`}
                  >
                    <div className="flex items-start">
                      <span className="font-mono mr-2">{index + 1}.</span>
                      <div>
                        <div className="truncate">{entry[0]}</div>
                        <div className="font-medium">Speaker: {entry[1]}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isProcessing && (
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <p className="text-xs text-muted-foreground text-right">
                  {completedEntries}/{totalEntries} completed
                </p>
                {eta && (
                  <span className="text-sm text-muted-foreground">{eta}</span>
                )}
              </div>
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-amber-500 font-medium mt-2">
                Please do not close this tab while processing is in progress.
              </p>
            </div>
          )}

          <div className="flex justify-between gap-2">
            <Button
              variant="outline"
              onClick={() => {
                if (inputRef.current) {
                  inputRef.current.value = "";
                }
              }}
              disabled={isProcessing}
            >
              Reset
            </Button>
            <Button type="submit" disabled={isProcessing}>
              {isProcessing ? "Processing..." : "Process"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
