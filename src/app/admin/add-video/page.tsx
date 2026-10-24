"use client";

// Add one YouTube video without downloading it (yt-only): transcript, search
// and chat as usual; the editor plays the YouTube embed and exports fetch the
// file from YouTube on demand.
import { useState } from "react";

type Check = {
  videoId: string; title: string; channel: string; lengthSeconds: number | null; publishedAt: string | null;
  suggestedSpeaker: string; existing: { video_source: string } | null; refusal: string | null; error?: string;
};
type Ev = { step: string; status: string; detail?: string; ms?: number; editUrl?: string; segments?: number; failedStep?: string };

const STEP_LABEL: Record<string, string> = {
  check: "Checking video", metadata: "Metadata", transcript: "Transcript fetched (Apify)", speakers: "Speakers",
  doc: "Transcript doc", bigquery: "Segments stored + search windows rebuilt", chat: "Chat file uploaded",
};

function fmtLen(sec: number | null) {
  if (sec == null) return "?";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export default function AddVideoPage() {
  const [url, setUrl] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [speaker, setSpeaker] = useState("");
  const [events, setEvents] = useState<Ev[]>([]);
  const [running, setRunning] = useState(false);

  const [looked, setLooked] = useState("");

  const lookup = async (value: string) => {
    setUrl(value);
    if (value.trim() === looked) return; // blur after Enter/paste: nothing new
    setLooked(value.trim());
    setCheck(null);
    setEvents([]);
    if (!value.trim()) return;
    setChecking(true);
    try {
      const r = await fetch(`/api/admin/add-video?url=${encodeURIComponent(value.trim())}`);
      const d = await r.json();
      setCheck(r.ok ? d : { ...d, error: d.error || "Lookup failed" });
      if (r.ok) setSpeaker(d.suggestedSpeaker || "");
    } finally {
      setChecking(false);
    }
  };

  const add = async () => {
    if (!check || !speaker.trim()) return;
    setRunning(true);
    setEvents([]);
    try {
      const r = await fetch("/api/admin/add-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: check.videoId, speaker: speaker.trim(), mode: "yt-only" }),
      });
      if (!r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) if (l.trim()) setEvents((prev) => [...prev, JSON.parse(l)]);
      }
    } catch (e: any) {
      setEvents((prev) => [...prev, { step: "error", status: "error", detail: e.message }]);
    } finally {
      setRunning(false);
    }
  };

  // Latest status per step, in order of first appearance.
  const steps: Ev[] = [];
  for (const e of events) {
    if (e.step === "done" || e.step === "error") continue;
    const i = steps.findIndex((x) => x.step === e.step);
    if (i >= 0) steps[i] = { ...steps[i], ...e, detail: e.detail ?? steps[i].detail };
    else steps.push(e);
  }
  const done = events.find((e) => e.step === "done");
  const error = events.find((e) => e.step === "error");
  const blocked = !check || !!check.error || !!check.refusal || !!check.existing;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">
      <meta name="robots" content="noindex" />
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Add a video</h1>
        <p className="text-sm text-gray-500 mt-1">
          YouTube-only: the transcript goes into search and chat; the video is never downloaded or stored. Clips are cut from YouTube at export time.
        </p>
      </div>

      <input
        data-testid="add-url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={(e) => lookup(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && lookup((e.target as HTMLInputElement).value)}
        onPaste={(e) => { const v = e.clipboardData.getData("text"); setTimeout(() => lookup(v), 0); }}
        placeholder="Paste a YouTube URL or video ID"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
      />

      {checking && <p className="text-sm text-gray-500">Looking it up…</p>}

      {check && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3 shadow-sm">
          {check.error ? (
            <p className="text-sm text-red-600">{check.error}</p>
          ) : (
            <>
              <div className="flex gap-3">
                {check.title && <img src={`https://i.ytimg.com/vi/${check.videoId}/mqdefault.jpg`} alt="" className="w-40 rounded" />}
                <div className="text-sm" data-testid="add-summary">
                  <p className="font-semibold text-gray-900">{check.title || check.videoId}</p>
                  <p className="text-gray-500">{[check.channel, fmtLen(check.lengthSeconds)].filter(Boolean).join(" · ")}</p>
                </div>
              </div>
              {check.refusal && <p className="text-sm text-red-600" data-testid="add-refusal">Can&apos;t add: {check.refusal}</p>}
              {check.existing && (
                <p className="text-sm text-amber-700">
                  Already in the library ({check.existing.video_source === "youtube" ? "YouTube-only" : "stored in Bunny"}).{" "}
                  <a className="underline" href={`/edit?v=${check.videoId}`}>Open in the editor</a>
                </p>
              )}
              <label className="block text-sm">
                <span className="text-gray-600">Speaker</span>
                <input
                  data-testid="add-speaker"
                  value={speaker}
                  onChange={(e) => setSpeaker(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <button
                data-testid="add-submit"
                onClick={add}
                disabled={blocked || running || !speaker.trim() || !!done}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50"
                style={{ backgroundColor: "#DC2626" }}
              >
                {running ? "Adding…" : "Add"}
              </button>
            </>
          )}
        </div>
      )}

      {(steps.length > 0 || error || done) && (
        <ol className="bg-white rounded-xl border border-gray-200 p-4 space-y-1.5 text-sm shadow-sm" data-testid="add-status">
          {steps.map((s) => (
            <li key={s.step} className="flex gap-2">
              <span className="w-4">{s.status === "ok" ? "✓" : s.status === "warn" ? "!" : "…"}</span>
              <span className={s.status === "warn" ? "text-amber-700" : "text-gray-800"}>
                {STEP_LABEL[s.step] || s.step}
                {s.detail && <span className="text-gray-500"> — {s.detail}</span>}
              </span>
              {s.ms != null && <span className="ml-auto text-gray-400 font-mono text-xs">{(s.ms / 1000).toFixed(1)}s</span>}
            </li>
          ))}
          {error && <li className="text-red-600">✕ Failed at {error.failedStep || "?"}: {error.detail}</li>}
          {done && (
            <li className="font-semibold text-green-700" data-testid="add-ready">
              ✓ Ready to clip — <a className="underline" href={done.editUrl}>open the editor</a>
              <span className="ml-2 font-normal text-gray-400 font-mono text-xs">{((done.ms || 0) / 1000).toFixed(1)}s total</span>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
