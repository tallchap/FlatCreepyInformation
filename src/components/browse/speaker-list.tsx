"use client";

import { Speaker } from "./utils/types";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useState } from "react";

export function SpeakerList({
  speakers,
  total,
  page,
  onPageChange,
  onSelect,
  isLoading,
}: {
  speakers: Speaker[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  onSelect: (speaker: string) => void;
  isLoading: boolean;
}) {
  const [filter, setFilter] = useState("");
  const totalPages = Math.ceil(total / 100);

  const filtered = filter
    ? speakers.filter((s) =>
        s.name.toLowerCase().includes(filter.toLowerCase()),
      )
    : speakers;

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          size={16}
        />
        <Input
          placeholder="Filter speakers on this page..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="text-center py-8 text-gray-500">
          Loading speakers...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {filtered.map((speaker) => (
              <Card
                key={speaker.name}
                className="cursor-pointer hover:border-blue-300 transition-colors"
                onClick={() => onSelect(speaker.name)}
              >
                <CardContent className="flex justify-between items-center py-3 px-4">
                  <span className="font-medium text-sm truncate">
                    {speaker.name}
                  </span>
                  <span className="text-xs text-gray-500 whitespace-nowrap ml-2">
                    {speaker.videoCount}{" "}
                    {speaker.videoCount === 1 ? "video" : "videos"}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>

          {filtered.length === 0 && (
            <p className="text-center text-gray-500 py-4">
              No speakers match your filter.
            </p>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
              >
                <ChevronLeft size={16} />
                Previous
              </Button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => onPageChange(page + 1)}
              >
                Next
                <ChevronRight size={16} />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
