"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SPEAKERS } from "@/lib/speakers";

interface SpeakerSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}

export function SpeakerSelect({
  value,
  onValueChange,
  disabled,
}: SpeakerSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className="w-[280px]">
        <SelectValue placeholder="Choose a speaker..." />
      </SelectTrigger>
      <SelectContent>
        {SPEAKERS.map((speaker) => (
          <SelectItem key={speaker.slug} value={speaker.slug}>
            {speaker.name} ({speaker.videoCount} videos)
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
