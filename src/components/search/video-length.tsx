import { Clock } from "lucide-react";

function formatVideoLength(timeString: string | undefined): string {
  // Check if the input is valid
  if (!timeString || typeof timeString !== "string") {
    return timeString || "";
  }

  // Parse the time string (MM:SS format)
  const parts = timeString.split(":");

  if (parts.length >= 2) {
    // Get minutes as number (first part)
    const minutes = parseInt(parts[0], 10);

    // Calculate hours and remaining minutes
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    // Format as HH:MM
    return `${hours}:${remainingMinutes.toString().padStart(2, "0")}`;
  }

  // Return original string if format is unexpected
  return timeString;
}

export function VideoLength({ length }: { length: string }) {
  return (
    <span className="flex items-center gap-1">
      <Clock size={16} />
      {formatVideoLength(length)}
    </span>
  );
}
