import { formatPlaybackTime } from "@/lib/clip-segments";

export function PlaybackPosition({ seconds, duration }: {
  seconds: number;
  duration: number;
}) {
  return (
    <div
      role="timer"
      aria-label="Current video position"
      aria-live="off"
      data-testid="timeline-position"
      className="rounded-lg bg-slate-100 px-2.5 py-1 text-slate-900"
    >
      <div className="flex items-baseline gap-2 whitespace-nowrap font-mono tabular-nums">
        <span data-testid="current-time" className="text-xl font-bold leading-tight">{formatPlaybackTime(seconds)}</span>
        <span className="text-xs text-slate-600">/ {duration > 0 ? formatPlaybackTime(duration) : "—"}</span>
      </div>
    </div>
  );
}
