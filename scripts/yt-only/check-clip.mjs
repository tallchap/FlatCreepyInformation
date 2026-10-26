// Does a downloaded clip hold exactly what the editor's Start/End said?
//
//   node scripts/yt-only/check-clip.mjs --clip ~/Downloads/clip-X.mp4 --video X \
//     --seg 98.181-112.362,128.962-137.345 [--reference source.mp4] [--out dir]
//
// --seg is the editor's own value (the `seg=` in its URL). The reference is
// YouTube's own DASH streams (video + original audio, pulled with yt-dlp and
// muxed without re-encoding), the timeline the YouTube player — and so the
// editor — shows. RapidAPI's whole-video file is NOT a valid reference: its
// video sits one frame late against its audio.
//
// For every segment:
//   start — the segment's first frame is the frame YouTube shows at Start
//           (last frame with pts ≤ in), and the sound there is the sound
//           YouTube plays with that frame;
//   end   — the segment's last frame is the frame YouTube shows just before End
//           (last frame with pts < out), sound likewise.
// Picture: a 48-frame run slid over the source (0 = exact; |x| ≤ 1 passes).
// Sound vs picture: 1.5 s cross-correlated (corr ≥ 0.8, |lag| ≤ 20 ms passes;
// negative = the sound is late, positive = early).
// Writes report.json plus, per boundary, a PNG with the source either side of
// the cut and the clip's frame. Exit 1 on any failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { checkCuts, pullYouTubeDash, streamDurations, SYNC_MS } from "./frame-match.mjs";

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const expand = (p) => p?.replace(/^~/, os.homedir());
const CLIP = expand(arg("clip"));
const VIDEO = arg("video");
const SEGMENTS = (arg("seg") || "").split(",").filter(Boolean).map((r) => { const m = r.match(/^([\d.]+)-([\d.]+)$/); return { in: Number(m[1]), out: Number(m[2]) }; });
if (!CLIP || !VIDEO || !SEGMENTS.length) { console.error("usage: --clip FILE --video ID --seg a-b[,c-d]"); process.exit(2); }
const OUT = expand(arg("out")) || path.join(process.cwd(), ".context", "check-clip", `${VIDEO}-${Date.now()}`);
fs.mkdirSync(OUT, { recursive: true });

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (e, so, se) => (e ? reject(new Error(`${e.message}\n${se}`)) : resolve({ stdout: so, stderr: se }))));
}

/** Full-size frame of `input` whose pts is `t` (to the ms; pts are printed rounded) → PNG. */
async function sourceFrame(input, t, file) {
  await run("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, t - 2)), "-copyts", "-i", input, "-vf", `select='gte(t\\,${t - 0.002})',scale=640:-2`, "-frames:v", "1", file]);
}
async function clipFrame(input, n, file) {
  await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-vf", `select='eq(n\\,${n})',scale=640:-2`, "-fps_mode", "passthrough", "-frames:v", "1", file]);
}
// Labelled side-by-side PNG (Pillow: this ffmpeg has no drawtext).
async function panel(files, labels, file) {
  const py = `import sys, json
from PIL import Image, ImageDraw, ImageFont
files, labels, out = json.loads(sys.argv[1])
ims = [Image.open(f).convert("RGB").resize((640, 360)) for f in files]
sheet = Image.new("RGB", (640 * len(ims) + 8 * (len(ims) - 1), 400), "white")
d = ImageDraw.Draw(sheet)
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 17)
for i, (im, lab) in enumerate(zip(ims, labels)):
    x = i * 648
    sheet.paste(im, (x, 40))
    d.text((x + 8, 10), lab, fill="black", font=font)
sheet.save(out)`;
  await run(process.env.PIL_PYTHON || "/tmp/pilenv/bin/python", ["-c", py, JSON.stringify([files, labels, file])]);
}

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

async function main() {
  const { stdout: probe } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", CLIP]);
  const p = JSON.parse(probe);
  const v = p.streams.find((s) => s.codec_type === "video");
  const [fa, fb] = v.r_frame_rate.split("/").map(Number);
  const fps = fb ? fa / fb : fa;
  const dur = Number(p.format.duration);
  const ref = expand(arg("reference")) || (await pullYouTubeDash(VIDEO, fps, OUT));
  const { cuts, frames: clipFrameCount, expectFrames } = await checkCuts({ clip: CLIP, segments: SEGMENTS, fps, ref });

  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${name} — ${detail}`); };
  const sign = (x) => (x >= 0 ? `+${x}` : `${x}`);
  const sd = await streamDurations(CLIP);
  check("sound runs the whole clip (audio track within 30 ms of video)", sd.video - sd.audio <= 0.03, `video ${sd.video.toFixed(3)} s, audio ${sd.audio.toFixed(3)} s`);
  check("frame count = every frame YouTube shows from Start to End", clipFrameCount === expectFrames, `${clipFrameCount} frames, expected ${expectFrames} (${dur.toFixed(3)} s @ ${fps.toFixed(3)} fps)`);
  for (const kind of ["start", "end"]) {
    const rows = cuts.filter((c) => c.kind === kind);
    const what = kind === "start" ? "first frame = what YouTube shows at Start" : "last frame = what YouTube shows just before End";
    check(`every ${kind === "start" ? "Start" : "End"}: ${what}`, rows.every((r) => r.picturePass), rows.map((r) => `#${r.segment} ${fmt(r.t)} ${sign(r.frameOffset)}f`).join(" · "));
    check(`every ${kind === "start" ? "Start" : "End"}: sound in sync with picture (±${SYNC_MS} ms)`, rows.every((r) => r.soundPass),
      rows.map((r) => `#${r.segment} ${r.soundPresent ? `${r.syncMs >= 0 ? "+" : ""}${r.syncMs} ms (corr ${r.audioCorr})` : "NO SOUND"}`).join(" · "));
  }
  const report = { clip: CLIP, video: VIDEO, reference: ref, segments: SEGMENTS, fps, durationSec: dur, streamDurations: sd, frames: clipFrameCount, expectFrames, cuts, shots: [], checks };
  const reportPath = path.join(OUT, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Picture proof: per cut, the source either side of it next to the clip's frame.
  const f = (n) => path.join(OUT, `tmp-${n}.png`);
  for (const c of cuts) {
    const png = path.join(OUT, `seg${c.segment}-${c.kind}.png`);
    if (c.kind === "start") {
      await sourceFrame(ref, c.expectedPts - 1 / fps, f("a")); await sourceFrame(ref, c.expectedPts, f("b")); await clipFrame(CLIP, c.clipFrame, f("c"));
      await panel([f("a"), f("b"), f("c")], ["YouTube: frame before", `YouTube at Start ${fmt(c.t)}`, `CLIP first frame (${sign(c.frameOffset)}f, sound ${c.syncMs} ms)`], png);
    } else {
      await sourceFrame(ref, c.expectedPts, f("a")); await clipFrame(CLIP, c.clipFrame, f("b")); await sourceFrame(ref, c.expectedPts + 1 / fps, f("c"));
      await panel([f("a"), f("b"), f("c")], [`YouTube just before End ${fmt(c.t)}`, `CLIP last frame (${sign(c.frameOffset)}f, sound ${c.syncMs} ms)`, "YouTube: frame after"], png);
    }
    report.shots.push(png);
  }
  for (const n of ["a", "b", "c"]) fs.rmSync(f(n), { force: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const bad = checks.filter((c) => !c.ok).length;
  console.log(`\n${bad ? "\x1b[31mFAILED" : "\x1b[32mALL CHECKS PASSED"}\x1b[0m · ${OUT}`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
