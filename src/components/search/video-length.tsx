import { Clock } from "lucide-react";

function formatVideoLength(timeString: string | undefined): string {
  // Check if the input is valid
  if (!timeString || typeof timeString !== "string") {
    return timeString || "";
  }

  // Parse the time string
  const parts = timeString.split(":");

  // Handle different formats
  if (parts.length === 2) {
    // mm:ss or m:ss format - convert to hours:minutes
    const minutes = parseInt(parts[0], 10);

    // Minutes will be displayed as is, we don't need to add seconds
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours === 0) {
      // Format as :MM (e.g., 43:21 → :43)
      return `:${remainingMinutes.toString().padStart(2, "0")}`;
    } else {
      // Format as H:MM (e.g., when minutes > 60)
      return `${hours}:${remainingMinutes.toString().padStart(2, "0")}`;
    }
  } else if (parts.length === 3) {
    // h:mm:ss or hh:mm:ss format - extract hours and minutes
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);

    // Format as H:MM or HH:MM
    return `${hours}:${minutes.toString().padStart(2, "0")}`;
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
