"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useDebugLog } from "./utils/hooks/useDebugLog";
import { cn } from "@/lib/utils";

export function DebugPanel() {
  const { entries, clearLog } = useDebugLog();
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            {open ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Debug Log ({entries.length})
          </button>
          {open && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearLog}
              className="h-7 text-xs text-gray-400 hover:text-red-500"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Clear
            </Button>
          )}
        </div>
      </CardHeader>
      {open && (
        <CardContent className="pt-0">
          <div className="max-h-64 overflow-y-auto space-y-1 font-mono text-xs">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={cn(
                  "flex gap-2 py-1 px-2 rounded",
                  entry.status === "error" && "bg-red-50 text-red-700",
                  entry.status === "success" && "bg-green-50 text-green-700",
                  entry.status === "info" && "bg-blue-50 text-blue-700"
                )}
              >
                <span className="text-gray-400 shrink-0">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span className="font-semibold shrink-0">[{entry.step}]</span>
                <span className="truncate">
                  {entry.videoTitle && (
                    <span className="text-gray-500">{entry.videoTitle}: </span>
                  )}
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
