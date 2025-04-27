"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { RotateCcw, Save, Settings } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { usePreface } from "./utils/hooks/use-preface";

const DEFAULT_PREFACE = "you are reviewing a video transcript. here it is:";

export function PrefaceDialog() {
  const [preface, setPreface, resetPreface] = usePreface();
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const handleSave = () => {
    setPreface(textAreaRef.current?.value || DEFAULT_PREFACE);
    toast.success("Transcript preface saved successfully");
  };
  const handleReset = () => {
    resetPreface();
    toast.success("Transcript preface reset to default");
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Settings size={16} />
          Customize Preface
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Customize Preface</DialogTitle>
          <DialogDescription>
            Customize the text that will be added before all transcripts. This
            will be saved in your browser and used across all videos.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          defaultValue={preface}
          placeholder="Enter your preface text..."
          className="min-h-[120px]"
          ref={textAreaRef}
        />
        <DialogFooter className="flex justify-between sm:justify-between">
          <DialogClose asChild>
            <Button variant="outline" onClick={handleReset}>
              <RotateCcw size={16} />
              Reset to Default
            </Button>
          </DialogClose>
          <div className="flex items-center gap-2">
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button onClick={handleSave}>
                <Save size={16} />
                Save Preface
              </Button>
            </DialogClose>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
