import { formatPlaybackTime } from "@/lib/clip-segments";

export function PlaybackPosition({ seconds, duration, overlay = false }: {
  seconds: number;
  duration: number;
  overlay?: boolean;
}) {
  return (
    <div
      role="timer"
      aria-label="Current video position"
      aria-live="off"
      data-testid={overlay ? "player-position" : "timeline-position"}
      className={overlay
        ? "absolute bottom-2 left-2 z-20 rounded-lg bg-black/80 px-3 py-1.5 text-white pointer-events-none"
        : "rounded-lg bg-slate-100 px-3 py-1.5 text-slate-900"}
    >
      <div className={`text-[10px] font-semibold uppercase tracking-wide ${overlay ? "text-white/80" : "text-slate-600"}`}>Video position</div>
      <div className="flex items-baseline gap-2 whitespace-nowrap font-mono tabular-nums">
        <span data-testid="current-time" className="text-xl font-bold leading-tight">{formatPlaybackTime(seconds)}</span>
        <span className={`text-xs ${overlay ? "text-white/80" : "text-slate-600"}`}>/ {duration > 0 ? formatPlaybackTime(duration) : "—"}</span>
      </div>
    </div>
  );
}
