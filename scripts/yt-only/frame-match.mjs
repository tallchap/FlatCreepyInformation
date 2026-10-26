// Cut-accuracy check: where in the source does each join of a clip land?
//
// The clip is decoded once to tiny grayscale frames; segment k starts at frame
// index Σ round(len_j × fps) (the cutter trims every segment to exactly that
// many frames). Source frames are decoded with their absolute timestamps
// (-copyts), and "the requested cut" is the first source frame with
// pts ≥ in — what ffmpeg's accurate seek and the editor both mean by `in`.
// A run of clip frames is slid over the source; the best offset is the cut
// error in frames. Audio is cross-correlated as a second, sub-frame signal.
import path from "node:path";
import { execFile } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message += `\n${String(stderr).slice(-800)}`; reject(err); } else resolve({ stdout, stderr: String(stderr) });
    });
  });
}

// 192×108: enough detail to tell adjacent frames apart on near-static shots.
const W = 192, H = 108, FRAME = W * H;
const scale = `scale=${W}:${H}:flags=area,format=gray`;

/** Every frame of a (short) file, in decode order. */
export async function allFrames(file) {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", scale, "-fps_mode", "passthrough", "-f", "rawvideo", "-"]);
  return Array.from({ length: Math.floor(stdout.length / FRAME) }, (_, i) => stdout.subarray(i * FRAME, (i + 1) * FRAME));
}

/** Frames of file/URL with absolute pts in [from, to). */
export async function framesWithPts(input, from, to) {
  const { stdout, stderr } = await run("ffmpeg", ["-v", "info", "-ss", String(Math.max(0, from - 2)), "-copyts", "-i", input,
    "-map", "0:v:0", "-vf", `select='gte(t\\,${from})*lt(t\\,${to})',showinfo,${scale}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-"]);
  const pts = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const n = Math.floor(stdout.length / FRAME);
  return Array.from({ length: Math.min(n, pts.length) }, (_, i) => ({ pts: pts[i], data: stdout.subarray(i * FRAME, (i + 1) * FRAME) }));
}

/** Mono 8 kHz float samples for [t, t+dur) (absolute timeline). */
export async function pcm(input, t, dur) {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, t)), "-i", input, "-t", String(dur),
    "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"]);
  const copy = Buffer.from(stdout);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

function mse(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s / a.length;
}

// Motion signature: frame-to-frame change. Static background and encoder
// noise mostly cancel, so a run of frames matches sharply even on talking heads.
function motionErr(a0, a1, b0, b1) {
  let s = 0;
  for (let i = 0; i < a1.length; i++) { const d = (a1[i] - a0[i]) - (b1[i] - b0[i]); s += d * d; }
  return s / a1.length;
}

/** Best offset (frames) of clip run vs source frames, where index `zero` is the requested cut. */
export function bestFrameOffset(clipRun, src, zero) {
  const k = clipRun.length;
  const scores = [];
  for (let o = 0; o + k <= src.length; o++) {
    let e = 0;
    for (let i = 1; i < k; i++) e += motionErr(clipRun[i - 1], clipRun[i], src[o + i - 1], src[o + i]) + 0.05 * mse(clipRun[i], src[o + i]);
    scores.push({ offset: o - zero, err: e / k });
  }
  scores.sort((a, b) => a.err - b.err);
  const [best, second] = scores;
  return { offset: best?.offset ?? null, err: best?.err ?? Infinity, margin: second ? second.err / (best.err || 1e-9) : null };
}

/** Audio lag (ms) of clip vs source; 0 = perfect, negative = clip audio early. */
export function bestAudioLag(clip, src, leadSec, rate = 8000) {
  const lead = Math.round(leadSec * rate);
  const n = Math.min(clip.length, src.length - 2 * lead);
  let best = { lagMs: null, corr: -Infinity };
  for (let o = 0; o <= 2 * lead; o++) {
    let dot = 0, ea = 0, eb = 0;
    for (let i = 0; i < n; i++) { const a = clip[i], b = src[o + i]; dot += a * b; ea += a * a; eb += b * b; }
    const c = dot / Math.sqrt(ea * eb || 1);
    if (c > best.corr) best = { lagMs: ((o - lead) / rate) * 1000, corr: c };
  }
  return best;
}

/**
 * One row per segment: frameOffset (0 = exact; |x| ≤ 1 passes), audioLagMs.
 * sourceAt(i) → { input, shift }: file/URL holding segment i's source, and the
 * amount to add to its timestamps to get video time (0 for the full video).
 */
export async function checkJoins({ clip, segments, fps, sourceAt, runFrames = 60, lead = 10, searchFrames = 600 }) {
  const clipFrames = await allFrames(clip);
  const rows = [];
  let idx = 0;
  let audioAt = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const frames = Math.round((seg.out - seg.in) * fps);
    const { input, shift = 0 } = await sourceAt(i);
    // The offset is the same through the whole segment (it is one contiguous
    // run of frames), so measure it where the picture moves most: a static
    // shot at the join can't tell adjacent frames apart.
    let w = 0, bestEnergy = -1;
    for (let s0 = 0; s0 + runFrames < Math.min(frames, searchFrames); s0 += 15) {
      let e = 0;
      for (let j = s0 + 1; j < s0 + runFrames; j++) { const a = clipFrames[idx + j - 1], b = clipFrames[idx + j]; for (let k = 0; k < b.length; k += 7) { const d = b[k] - a[k]; e += d * d; } }
      if (e > bestEnergy) { bestEnergy = e; w = s0; }
    }
    const src = await framesWithPts(input, seg.in - shift - (lead + 2) / fps, seg.in - shift + (w + runFrames + lead + 2) / fps);
    const zero = src.findIndex((f) => f.pts + shift >= seg.in - 1e-4) + w;
    const run = clipFrames.slice(idx + w, idx + w + runFrames);
    const v = bestFrameOffset(run, src.map((f) => f.data).slice(Math.max(0, zero - lead - 2)), Math.min(zero, lead + 2));
    // Wide search (±1.5 s) so a big audio offset is measured, not mistaken for noise.
    const clipA = await pcm(clip, audioAt + 0.05, 1.5);
    const srcA = await pcm(input, seg.in - shift + 0.05 - 1.5, 4.5);
    const a = bestAudioLag(clipA, srcA, 1.5);
    rows.push({
      segment: i + 1, in: seg.in, clipFrame: idx, measuredAt: `+${(w / fps).toFixed(1)}s`, frameOffset: v.offset, frameErr: Number(v.err.toFixed(2)),
      margin: v.margin == null ? null : Number(v.margin.toFixed(2)),
      audioLagMs: a.lagMs == null ? null : Number(a.lagMs.toFixed(1)), audioCorr: Number(a.corr.toFixed(3)),
      pass: v.offset != null && Math.abs(v.offset) <= 1,
    });
    idx += frames;
    audioAt += frames / fps;
  }
  return rows;
}

// ── Clip vs YouTube, the way the player shows it ──
// The reference is YouTube's own DASH streams (video + original audio, muxed
// without re-encoding). RapidAPI's whole-video file is NOT a valid reference:
// its video sits one frame late against its audio.
export const SYNC_MS = 20;
const runText = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (e, so, se) => (e ? reject(new Error(`${e.message}\n${se}`)) : resolve(so))));

/** Frames YouTube shows from `in` up to `out`. */
export function framesShown(seg, fps) {
  return Math.max(1, Math.ceil(seg.out * fps - 1e-6) - Math.floor(seg.in * fps + 1e-6));
}

/** Every cut of a clip (Start and End of each segment), picture and sound. */
export async function checkCuts({ clip, segments, fps, ref }) {
  const clipFrames = await allFrames(clip);
  // Where each segment sits in the clip. Clips cut before 2026-10-26 used
  // round((out − in) × fps) frames per segment; read those by that rule.
  let lens = segments.map((s) => framesShown(s, fps));
  const expectFrames = lens.reduce((a, b) => a + b, 0);
  const oldLens = segments.map((s) => Math.max(1, Math.round((s.out - s.in) * fps)));
  if (clipFrames.length !== expectFrames && clipFrames.length === oldLens.reduce((a, b) => a + b, 0)) lens = oldLens;
  const cuts = [];
  let idx = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const frames = lens[i];
    cuts.push({ segment: i + 1, ...(await checkCut({ clip, clipFrames, clipIdx: idx, segFrames: frames, t: s.in, kind: "start", fps, ref })) });
    cuts.push({ segment: i + 1, ...(await checkCut({ clip, clipFrames, clipIdx: idx + frames - 1, segFrames: frames, t: s.out, kind: "end", fps, ref })) });
    idx += frames;
  }
  return { cuts, frames: clipFrames.length, expectFrames };
}

// YouTube's DASH streams for the video, muxed by stream copy (timestamps untouched).
export async function pullYouTubeDash(videoId, fps, dir) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const v = path.join(dir, "dash-video.mp4"), a = path.join(dir, "dash-audio.m4a"), file = path.join(dir, "reference-dash.mp4");
  console.log("pulling YouTube DASH streams with yt-dlp...");
  // Same frame rate as the clip; 480p is plenty (frames are compared at 192×108, proof images at 640 wide).
  const vf = fps > 50 ? "bv[fps>50][height<=720][ext=mp4]" : "bv[fps<50][height<=480][ext=mp4]";
  await runText("yt-dlp", ["--ignore-config", "-f", vf, "-o", v, url]);
  await runText("yt-dlp", ["--ignore-config", "-f", "ba[ext=m4a]", "-o", a, url]); // yt-dlp picks the original-language track
  await runText("ffmpeg", ["-v", "error", "-y", "-i", v, "-i", a, "-map", "0:v", "-map", "1:a", "-c", "copy", file]);
  return file;
}

/**
 * One cut point. kind "start": the clip frame at `clipIdx` should be the source
 * frame showing at `t`; kind "end": the clip frame at `clipIdx` (the segment's
 * last) should be the last source frame before `t`. Picture is matched on the
 * most-moving 48-frame run next to the cut; sound is compared against the
 * source sound at the matched frame.
 */
export async function checkCut({ clip, clipFrames, clipIdx, segFrames, t, kind, fps, ref, run = 48, search = 480, lead = 10 }) {
  // Run of clip frames inside the segment, as near the cut as motion allows.
  let w = 0, bestEnergy = -1;
  for (let s0 = 0; s0 + run < Math.min(segFrames, search); s0 += 12) {
    const from = kind === "start" ? clipIdx + s0 : clipIdx - s0 - run + 1;
    let e = 0;
    for (let j = from + 1; j < from + run; j++) { const a = clipFrames[j - 1], b = clipFrames[j]; for (let k = 0; k < b.length; k += 7) { const d = b[k] - a[k]; e += d * d; } }
    if (e > bestEnergy) { bestEnergy = e; w = s0; }
  }
  const runFrom = kind === "start" ? clipIdx + w : clipIdx - w - run + 1;
  const span = (w + run + lead + 2) / fps;
  const src = await framesWithPts(ref, kind === "start" ? t - (lead + 2) / fps : t - span, kind === "start" ? t + span : t + (lead + 2) / fps);
  // Index of the source frame the cut should land on.
  const expectIdx = kind === "start" ? src.findLastIndex((f) => f.pts <= t + 1e-4) : src.findLastIndex((f) => f.pts < t - 1e-4);
  const zero = kind === "start" ? expectIdx + w : expectIdx - w - run + 1; // expected source index of runFrom
  const lo = Math.max(0, zero - lead - 2);
  const v = bestFrameOffset(clipFrames.slice(runFrom, runFrom + run), src.map((f) => f.data).slice(lo), zero - lo);
  const gotIdx = expectIdx + v.offset; // source frame the clip's cut frame really is
  const gotPts = src[gotIdx]?.pts;
  // Sound vs picture: clip sound next to the cut against source sound next to the matched frame.
  const clipT = clipIdx / fps, len = 1.5;
  const [cFrom, sFrom] = kind === "start" ? [clipT + 0.05, gotPts + 0.05] : [clipT + 1 / fps - 0.05 - len, gotPts + 1 / fps - 0.05 - len];
  const a = bestAudioLag(await pcm(clip, cFrom, len), await pcm(ref, sFrom - 1.5, len + 3), 1.5);
  const syncMs = a.lagMs == null ? null : Number(a.lagMs.toFixed(1));
  return {
    kind, t, clipFrame: clipIdx, frameOffset: v.offset, frameErr: Number(v.err.toFixed(2)), margin: v.margin == null ? null : Number(v.margin.toFixed(2)),
    expectedPts: src[expectIdx]?.pts, gotPts, syncMs, audioCorr: Number(a.corr.toFixed(3)),
    picturePass: v.offset != null && Math.abs(v.offset) <= 1, soundPass: a.corr >= 0.8 && Math.abs(syncMs) <= SYNC_MS,
  };
}

