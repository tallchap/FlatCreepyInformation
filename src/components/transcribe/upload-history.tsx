"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useState, useMemo } from "react";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from "@/components/ui/pagination";

import {
  ExternalLink,
  FileVideo,
  Calendar,
  CheckCircle,
  XCircle,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranscriptHistory } from "@/components/transcribe/utils/hooks/useTranscriptHistory";
import { cn } from "@/lib/utils";

// Page size for pagination
const PAGE_SIZE = 5;

function extractVideoId(url: string): string | null {
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([A-Za-z0-9_-]{11})/
  );
  return m?.[1] ?? null;
}

type PaginationItemType = {
  type: "number" | "ellipsis";
  page?: number;
};

/**
 * Generate pagination items dynamically
 */
const generatePaginationItems = (
  currentPage: number,
  totalPages: number
): PaginationItemType[] => {
  // If we have 7 or fewer pages, show all of them
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => ({
      type: "number",
      page: i + 1,
    }));
  }

  // Otherwise, show the first page, the last page, the current page,
  // and one or two pages on either side of the current page
  const items: PaginationItemType[] = [{ type: "number", page: 1 }];

  const leftBoundary = Math.max(2, currentPage - 1);
  const rightBoundary = Math.min(totalPages - 1, currentPage + 1);

  // Add ellipsis if there's a gap between first page and left boundary
  if (leftBoundary > 2) {
    items.push({ type: "ellipsis" });
  }

  // Add pages around the current page
  for (let i = leftBoundary; i <= rightBoundary; i++) {
    items.push({ type: "number", page: i });
  }

  // Add ellipsis if there's a gap between right boundary and last page
  if (rightBoundary < totalPages - 1) {
    items.push({ type: "ellipsis" });
  }

  // Add the last page
  if (totalPages > 1) {
    items.push({ type: "number", page: totalPages });
  }

  return items;
};

/**
 * Upload history table component
 * This can be embedded in other pages or used standalone
 */
export function UploadHistoryTable() {
  const [page, setPage] = useState(1);
  const { transcriptHistory } = useTranscriptHistory();

  // Paginate local storage data
  const startIndex = (page - 1) * PAGE_SIZE;
  const paginatedHistory = transcriptHistory.slice(
    startIndex,
    startIndex + PAGE_SIZE
  );
  const totalPages = Math.ceil(transcriptHistory.length / PAGE_SIZE);

  // Generate pagination items
  const paginationItems = useMemo(
    () => generatePaginationItems(page, totalPages),
    [page, totalPages]
  );

  // Handle pagination
  const handlePageChange = (newPage: number) => {
    if (newPage > 0 && newPage <= totalPages) {
      setPage(newPage);
    }
  };

  // Format date for display
  const formatDate = (dateValue: Date | string | null) => {
    if (!dateValue) return "Unknown";
    const date =
      typeof dateValue === "string" ? new Date(dateValue) : dateValue;
    return date.toLocaleString();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Uploads</CardTitle>
        <CardDescription>
          A list of all videos you've processed through the system
        </CardDescription>
      </CardHeader>
      <CardContent>
        {transcriptHistory.length > 0 ? (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Video Title</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Actions</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedHistory.map((upload) => (
                  <TableRow key={upload.id}>
                    <TableCell className="font-medium max-w-96">
                      {upload.youtubeLink ? (
                        <a
                          href={upload.youtubeLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:underline flex items-center"
                          title={upload.videoTitle || "Untitled Video"}
                        >
                          <FileVideo className="h-4 w-4 mr-2 flex-shrink-0" />
                          <span className="truncate">
                            {upload.videoTitle || "Untitled Video"}
                          </span>
                          <ExternalLink className="h-3 w-3 ml-1 flex-shrink-0" />
                        </a>
                      ) : (
                        <span
                          className="flex items-center"
                          title={upload.videoTitle || "Untitled Video"}
                        >
                          <FileVideo className="h-4 w-4 mr-2 flex-shrink-0" />
                          <span className="truncate">
                            {upload.videoTitle || "Untitled Video"}
                          </span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="flex items-center">
                      <Calendar className="h-4 w-4 mr-2" />
                      {formatDate(upload.uploadedAt)}
                    </TableCell>
                    <TableCell>
                      {upload.status === "vectorizing" ? (
                        <span className="flex items-center text-amber-500 text-sm font-medium">
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          Vectorizing...
                        </span>
                      ) : upload.status === "success" && upload.youtubeLink && extractVideoId(upload.youtubeLink) ? (
                        <Link
                          href={`/edit?v=${extractVideoId(upload.youtubeLink)}`}
                          target="_blank"
                          className="text-[#DC2626] hover:text-[#B91C1C] font-semibold text-sm"
                        >
                          Snip It
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "flex items-center font-medium",
                          upload.status === "success"
                            ? "text-green-500"
                            : upload.status === "vectorizing"
                            ? "text-amber-500"
                            : "text-red-500"
                        )}
                      >
                        {upload.status === "success" ? (
                          <CheckCircle className="h-4 w-4 mr-1" />
                        ) : upload.status === "vectorizing" ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <XCircle className="h-4 w-4 mr-1" />
                        )}
                        {upload.status === "success"
                          ? "Success"
                          : upload.status === "vectorizing"
                          ? "Vectorizing"
                          : upload.failedStep
                          ? `Failed @ ${upload.failedStep}`
                          : "Failed"}
                      </span>
                      {upload.errorMessage && (
                        <p className="text-xs text-red-400 mt-0.5 truncate max-w-48" title={upload.errorMessage}>
                          {upload.errorMessage}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="text-center p-8 border rounded-md">
            <h3 className="text-lg font-medium mb-2">No uploads found</h3>
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              You haven't uploaded any YouTube videos for processing yet.
            </p>
          </div>
        )}
      </CardContent>
      {transcriptHistory.length > 0 && totalPages > 1 && (
        <CardFooter className="flex justify-center">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => handlePageChange(page - 1)}
                  className={
                    page === 1
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                />
              </PaginationItem>

              {paginationItems.map((item, index) => (
                <PaginationItem key={index}>
                  {item.type === "number" && item.page ? (
                    <PaginationLink
                      onClick={() => item.page && handlePageChange(item.page)}
                      isActive={page === item.page}
                      className="cursor-pointer"
                    >
                      {item.page}
                    </PaginationLink>
                  ) : (
                    <PaginationEllipsis />
                  )}
                </PaginationItem>
              ))}

              <PaginationItem>
                <PaginationNext
                  onClick={() => handlePageChange(page + 1)}
                  className={
                    page === totalPages
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </CardFooter>
      )}
    </Card>
  );
}
