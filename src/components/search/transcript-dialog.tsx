import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Copy, Edit, FileText, Save, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Textarea } from "../ui/textarea";
import { usePreface } from "./utils/hooks/use-preface";
import { VideoResult as VideoResultType } from "./utils/types";

export function TranscriptDialog({ video }: { video: VideoResultType }) {
  const [fullTranscript, setFullTranscript] = useState(() => {
    if (video.Search_Doc_1) {
      return video.Search_Doc_1.replace(/\n\n/g, "\n");
    }
    return "";
  });
  const [isEditing, setIsEditing] = useState(false);
  const [editedTranscript, setEditedTranscript] = useState("");
  const [open, setOpen] = useState(false);
  const [preface] = usePreface();

  const saveEditedTranscript = () => {
    // Check if the edited transcript includes the preface text
    if (editedTranscript.includes(preface)) {
      // Find the position after the preface text (after the double newline)
      const prefaceEndIndex = editedTranscript.indexOf("\n\n") + 2;
      if (prefaceEndIndex >= 2) {
        // Extract just the transcript part (after the preface)
        const transcriptPart = editedTranscript.substring(prefaceEndIndex);
        setFullTranscript(transcriptPart);
      } else {
        // If we can't find the double newline, just save as is
        setFullTranscript(editedTranscript);
      }
    } else {
      // If no preface is present, save as is
      setFullTranscript(editedTranscript);
    }

    setIsEditing(false);
    toast.success("Transcript updated successfully!");
  };

  const startEditing = () => {
    setEditedTranscript(`${preface}\n\n${fullTranscript}`);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditedTranscript("");
  };

  const copyTranscript = () => {
    // If editing, use the edited text as is (which already includes the preface)
    // If not editing, add the preface text to the transcript
    const textToCopy = isEditing
      ? editedTranscript
      : `${preface}\n\n${fullTranscript}`;

    navigator.clipboard
      .writeText(textToCopy)
      .then(() => {
        toast.success("Preface + transcript copied to clipboard!");
      })
      .catch((err) => {
        console.error("Failed to copy text: ", err);
        toast.error("Failed to copy transcript. Please try again.");
      });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FileText className="h-4 w-4 mr-2" />
          Preface + Transcript
        </Button>
      </DialogTrigger>
      <DialogContent className="min-w-4xl w-[90vw] h-[80vh] flex flex-col">
        <DialogHeader className="flex flex-row items-center justify-between border-b pb-2">
          <DialogTitle className="text-xl font-semibold">
            Preface + Transcript: {video.Video_Title}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto mt-4 relative">
          <div className="flex justify-between items-center mb-3">
            <div className="text-sm text-gray-500">
              <span className="font-medium">
                {isEditing
                  ? editedTranscript.length.toLocaleString()
                  : `${preface}\n\n${fullTranscript}`.length.toLocaleString()}
              </span>{" "}
              characters
            </div>
            <div className="flex gap-2">
              {isEditing ? (
                <>
                  <Button onClick={cancelEditing} variant="outline" size="sm">
                    <X size={16} />
                    Cancel
                  </Button>
                  <Button
                    onClick={saveEditedTranscript}
                    variant="outline"
                    size="sm"
                  >
                    <Save size={16} />
                    Save Changes
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={startEditing} variant="outline" size="sm">
                    <Edit size={16} />
                    Edit Transcript
                  </Button>
                  <Button onClick={copyTranscript} variant="outline" size="sm">
                    <Copy size={16} />
                    Copy to Clipboard
                  </Button>
                </>
              )}
            </div>
          </div>

          {isEditing ? (
            <Textarea
              value={editedTranscript}
              onChange={(e) => setEditedTranscript(e.target.value)}
              className="h-full min-h-[400px] font-mono text-sm p-4"
              placeholder="Enter the transcript text here..."
            />
          ) : (
            <div className="bg-gray-50 p-4 rounded-md whitespace-pre-wrap text-sm font-mono h-full overflow-auto">
              {`${preface}\n\n${
                fullTranscript || "No transcript data available."
              }`}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
