"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchQueryInfo } from "./search-query-info";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { searchTranscript } from "./utils/actions";
import { toast } from "sonner";

export function SearchForm({
  data,
  setData,
  isLoading,
  setIsLoading,
}: {
  data: Record<string, any> | undefined;
  setData: (data: Record<string, any>) => void;
  isLoading: boolean;
  setIsLoading: (isLoading: boolean) => void;
}) {
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    if (
      !formData.get("searchQuery") &&
      !formData.get("speakerQuery") &&
      !formData.get("channelQuery")
    ) {
      toast.error("Please enter a query");
      return;
    }
    try {
      setIsLoading(true);
      const result = await searchTranscript(formData);
      setData(result);
    } catch (error) {
      console.error(error);
      toast.error("An error occurred");
    } finally {
      setIsLoading(false);
    }
  };
  return (
    <Card>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="searchQuery">Search in Transcripts</Label>
            <Input
              id="searchQuery"
              name="searchQuery"
              defaultValue={data?.searchQuery || ""}
              placeholder="Enter keywords (e.g., toronto OR program*)"
            />
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">
                Separate multiple keywords with "OR". Use * for wildcards e.g.,
                program*
              </span>
              <SearchQueryInfo />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="speakerQuery">
                Speaker{" "}
                <span className="text-xs text-gray-500">(Optional)</span>
              </Label>
              <Input
                id="speakerQuery"
                name="speakerQuery"
                defaultValue={data?.speakerQuery || ""}
                placeholder="Enter speaker name..."
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="channelQuery">
                Channel{" "}
                <span className="text-xs text-gray-500">(Optional)</span>
              </Label>
              <Input
                id="channelQuery"
                name="channelQuery"
                defaultValue={data?.channelQuery || ""}
                placeholder="Enter channel name..."
              />
            </div>
          </div>
          <div className="flex gap-4 flex-col md:flex-row md:items-center">
            <div className="flex gap-2 items-center">
              <Label>Sort by Date</Label>
              <Select
                name="sortOrder"
                defaultValue={data?.sortOrder || "recent"}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Sort Order" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recent">Most Recent</SelectItem>
                  <SelectItem value="oldest">Oldest First</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 items-center">
              <Label>Number of Results</Label>
              <Select
                name="resultLimit"
                defaultValue={data?.resultLimit || "10"}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Limit" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 items-center">
              <Label>Year Filter</Label>
              <Select
                name="yearFilter"
                defaultValue={data?.yearFilter || "all"}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Year" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Years</SelectItem>
                  {Array.from(
                    { length: new Date().getFullYear() - 2009 + 1 },
                    (_, i) => new Date().getFullYear() - i
                  ).map((year) => (
                    <SelectItem key={year} value={year.toString()}>
                      {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? "Searching..." : "Search Videos"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
