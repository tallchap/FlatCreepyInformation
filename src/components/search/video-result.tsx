import { Card, CardContent } from "@/components/ui/card";
import { Calendar, FileText, Youtube } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MatchSnippets } from "./match-snippets";
import { VideoResult as VideoResultType } from "./utils/types";
import { VideoLength } from "./video-length";
import { TranscriptDialog } from "./transcript-dialog";

export function VideoResult({ video }: { video: VideoResultType }) {
  return (
    <Card className="hover:border-blue-200 transition-all">
      <CardContent>
        <div className="flex flex-col md:flex-row justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Link
              href={video.Youtube_Link}
              rel="noopener noreferrer"
              className="text-lg font-medium text-blue-800 hover:underline"
            >
              {video.Video_Title}
            </Link>
            <div className="flex gap-4 text-sm text-gray-500">
              <span className="flex items-center gap-1">
                <Youtube size={16} />
                {video.Channel_Name}
              </span>
              <span className="flex items-center gap-1">
                <Calendar size={16} />
                {typeof video.Published_Date === "object"
                  ? (video.Published_Date as any)?.value || "Unknown Date"
                  : video.Published_Date}
              </span>
              <VideoLength length={video.Video_Length} />
            </div>
            <p className="text-sm text-gray-700 mb-2">
              <span className="font-medium">Speakers:</span> {video.Speakers}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link
                href={video.Transcript_Doc_Link}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileText size={16} />
                Transcript
              </Link>
            </Button>
            <TranscriptDialog video={video} />
          </div>
        </div>
         {video.MatchSnippets && video.MatchSnippets.length > 0 && (
           <MatchSnippets
             videoId={video.ID}            // ← ID is the YouTube id from BigQuery
             snippets={video.MatchSnippets}
             className="mt-4"
           />
        )}
      </CardContent>
    </Card>
  );
}
