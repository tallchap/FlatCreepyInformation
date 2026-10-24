// Cut-accuracy check: where in the source does each join of a clip land?
//
// The clip is decoded once to tiny grayscale frames; segment k starts at frame
// index Σ round(len_j × fps) (the cutter trims every segment to exactly that
// many frames). Source frames are decoded with their absolute timestamps
// (-copyts), and "the requested cut" is the first source frame with
// pts ≥ in — what ffmpeg's accurate seek and the editor both mean by `in`.
// A run of clip frames is slid over the source; the best offset is the cut
// error in frames. Audio is cross-correlated as a second, sub-frame signal.
import { execFile } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message += `\n${String(stderr).slice(-800)}`; reject(err); } else resolve({ stdout, stderr: String(stderr) });
    });
  });
}

const W = 64, H = 36, FRAME = W * H;
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

/** Best offset (frames) of clip run vs source frames, where index `zero` is the requested cut. */
export function bestFrameOffset(clipRun, src, zero) {
  const k = clipRun.length;
  const scores = [];
  for (let o = 0; o + k <= src.length; o++) {
    let e = 0;
    for (let i = 0; i < k; i++) e += mse(clipRun[i], src[o + i]);
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
export async function checkJoins({ clip, segments, fps, sourceAt, runFrames = 30, lead = 10 }) {
  const clipFrames = await allFrames(clip);
  const rows = [];
  let idx = 0;
  let audioAt = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const frames = Math.round((seg.out - seg.in) * fps);
    const { input, shift = 0 } = await sourceAt(i);
    const src = await framesWithPts(input, seg.in - shift - (lead + 2) / fps, seg.in - shift + (runFrames + lead + 2) / fps);
    const zero = src.findIndex((f) => f.pts + shift >= seg.in - 1e-4);
    const run = clipFrames.slice(idx, idx + runFrames);
    const v = bestFrameOffset(run, src.map((f) => f.data), zero);
    const clipA = await pcm(clip, audioAt + 0.05, 1.5);
    const srcA = await pcm(input, seg.in - shift + 0.05 - 0.25, 2.0);
    const a = bestAudioLag(clipA, srcA, 0.25);
    rows.push({
      segment: i + 1, in: seg.in, clipFrame: idx, frameOffset: v.offset, frameErr: Number(v.err.toFixed(2)),
      margin: v.margin == null ? null : Number(v.margin.toFixed(2)),
      audioLagMs: a.lagMs == null ? null : Number(a.lagMs.toFixed(1)), audioCorr: Number(a.corr.toFixed(3)),
      pass: v.offset != null && Math.abs(v.offset) <= 1,
    });
    idx += frames;
    audioAt += frames / fps;
  }
  return rows;
}
