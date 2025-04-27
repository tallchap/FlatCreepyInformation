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

export function SearchForm({
  action,
  isPending,
  formData,
}: {
  action: (formData: FormData) => void;
  isPending: boolean;
  formData: FormData;
}) {
  return (
    <Card>
      <CardContent>
        <form action={action} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="searchQuery">Search in Transcripts</Label>
            <Input
              id="searchQuery"
              name="searchQuery"
              defaultValue={formData?.get("searchQuery")?.toString() || ""}
              placeholder="Enter keywords (e.g., toronto OR program*)"
              required
            />
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">
                Separate multiple keywords with "OR". Use * for wildcards e.g.,
                program*
              </span>
              <SearchQueryInfo />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="speakerQuery">
              Search by Speaker{" "}
              <span className="text-xs text-gray-500">(Optional)</span>
            </Label>
            <Input
              id="speakerQuery"
              name="speakerQuery"
              defaultValue={formData?.get("speakerQuery")?.toString() || ""}
              placeholder="Enter speaker name..."
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="channelQuery">
              Search by Channel{" "}
              <span className="text-xs text-gray-500">(Optional)</span>
            </Label>
            <Input
              id="channelQuery"
              name="channelQuery"
              defaultValue={formData?.get("channelQuery")?.toString() || ""}
              placeholder="Enter channel name..."
            />
          </div>
          <div className="flex gap-4 flex-col md:flex-row md:items-center">
            <div className="flex gap-2 items-center">
              <Label>Sort by Date</Label>
              <Select
                name="sortOrder"
                defaultValue={
                  formData?.get("sortOrder")?.toString() || "recent"
                }
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
                defaultValue={formData?.get("resultLimit")?.toString() || "10"}
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
                defaultValue={formData?.get("yearFilter")?.toString() || "all"}
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
          <Button type="submit" disabled={isPending}>
            {isPending ? "Searching..." : "Search Videos"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
