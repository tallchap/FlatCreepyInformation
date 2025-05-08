"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "../ui/button";
import { useRef, useState } from "react";
import papa from "papaparse";
import { toast } from "sonner";
import { singleExtract } from "./utils/actions";
import { useTranscriptHistory } from "./utils/hooks/useTranscriptHistory";
import { Progress } from "@/components/ui/progress";
import { Upload } from "lucide-react";

export function BulkForm() {
  const [data, setData] = useState<[string, string][]>([]);
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [completedEntries, setCompletedEntries] = useState(0);
  const [totalEntries, setTotalEntries] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const { addTranscript } = useTranscriptHistory();
  const [isSuccess, setIsSuccess] = useState(false);
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFileName(file.name);
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

  const handleSubmit = async () => {
    if (data.length === 0) {
      toast.error("Please upload a CSV file");
      return;
    }

    setIsProcessing(true);
    setIsSuccess(false);
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
    setIsSuccess(true);
    setFileName(null);
  };

  return (
    <Dialog>
      <DialogTrigger className="flex items-center gap-2" asChild>
        <Button variant="outline">
          <Upload size={16} />
          Bulk Import
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk Upload YouTube Videos</DialogTitle>
          <DialogDescription>
            Upload a CSV file with YouTube links and speaker names
          </DialogDescription>
        </DialogHeader>

        <div className="border border-dashed rounded-md p-6 flex flex-col items-center justify-center space-y-2">
          <div className="w-12 h-12 flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-8 h-8 text-gray-400"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">YouTube URL, Speaker Name</p>

            <input
              id="csvFile"
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              ref={inputRef}
              className="hidden"
            />

            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => inputRef.current?.click()}
                disabled={isProcessing}
              >
                Choose File
              </Button>
            </div>

            <p className="text-xs text-gray-500 mt-2">
              {fileName ? fileName : "No file chosen"}
            </p>
          </div>
        </div>

        <div className="bg-muted p-3 rounded-md">
          <p className="text-md font-medium mb-1">Example Format:</p>
          <div className="text-xs">
            <p>https://www.youtube.com/watch?v=abc123, John Doe</p>
            <p>https://www.youtube.com/watch?v=def456, Jane Smith</p>
            <br />
            <p>(NOTE: there are no column headers)</p>
          </div>
        </div>

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
        {isSuccess && (
          <p className="text-green-500">All entries have been processed.</p>
        )}

        <DialogFooter className="flex justify-between">
          <DialogClose asChild>
            <Button variant="outline" disabled={isProcessing}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            onClick={handleSubmit}
            disabled={isProcessing || data.length === 0}
          >
            Process
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
