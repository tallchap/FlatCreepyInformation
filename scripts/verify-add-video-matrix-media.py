#!/usr/bin/env python3
"""Media checks for clips exported by verify-add-video-matrix.cjs.

For each QA_OUT/<videoId>/clip.mp4:
  length    file duration vs the editor's Start/End (±0.5 s)
  shape     clip aspect ratio vs the YouTube source (player embed size, ±3%)
  sound     audio stream present, integrated loudness above -40 LUFS
  speech    OpenAI transcription of the clip vs the site transcript lines
            inside Start/End: share of the site's words heard in the clip
  picture   contact sheet (5 frames) reviewed by an independent Claude call:
            real footage, not black/frozen/corrupt, not stretched, no bars added

Usage: python3 scripts/verify-add-video-matrix-media.py QA_OUT
Env: OPENAI_API_KEY, ANTHROPIC_API_KEY, YOUTUBE_API_KEY. Exits 1 on any FAIL.
"""
import base64, json, os, re, subprocess, sys, urllib.request, urllib.parse, uuid

OUT = sys.argv[1]
SITE = "https://www.snippysaurus.com"
REVIEW_MODEL = os.environ.get("REVIEW_MODEL", "claude-opus-4-7")


def sh(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def get_json(url, headers=None, data=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def probe(path):
    d = json.loads(sh("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path).stdout)
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    a = [s for s in d["streams"] if s["codec_type"] == "audio"]
    fps = v.get("avg_frame_rate", "0/1").split("/")
    sar = v.get("sample_aspect_ratio", "1:1")
    sar = 1.0 if sar in ("0:1", "N/A") else int(sar.split(":")[0]) / int(sar.split(":")[1])
    return {
        "duration": float(d["format"]["duration"]),
        "width": v["width"], "height": v["height"], "dar": v["width"] * sar / v["height"],
        "vcodec": v["codec_name"], "fps": round(int(fps[0]) / max(1, int(fps[1])), 2),
        "audio": bool(a), "acodec": a[0]["codec_name"] if a else None,
    }


def lufs(path):
    err = sh("ffmpeg", "-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-").stderr
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", err)
    return float(m[-1]) if m else None


def black_ratio(path, dur):
    err = sh("ffmpeg", "-i", path, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-").stderr
    black = sum(float(x) for x in re.findall(r"black_duration:([\d.]+)", err))
    return black / dur if dur else 1


def source_ar(vid):
    key = os.environ["YOUTUBE_API_KEY"]
    d = get_json(f"https://www.googleapis.com/youtube/v3/videos?part=player&maxWidth=1000&id={vid}&key={key}")
    p = d["items"][0]["player"]
    return int(p["embedWidth"]) / int(p["embedHeight"])


def words(t):
    t = re.sub(r"\[[^\]]*\]", " ", t.lower())
    return re.findall(r"[a-z0-9']+", t)


def transcribe(path, tmpdir):
    mp3 = os.path.join(tmpdir, "audio.mp3")
    sh("ffmpeg", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3)
    boundary = uuid.uuid4().hex
    body = b""
    for k, v in (("model", "whisper-1"), ("language", "en"), ("response_format", "json")):
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode()
    body += open(mp3, "rb").read() + f"\r\n--{boundary}--\r\n".encode()
    d = get_json("https://api.openai.com/v1/audio/transcriptions", data=body, headers={
        "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    return d["text"]


def contact_sheet(path, dur, dest):
    ts = [dur * f for f in (0.05, 0.25, 0.5, 0.75, 0.95)]
    frames = []
    for i, t in enumerate(ts):
        f = dest.replace(".jpg", f"-{i}.jpg")
        sh("ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", path, "-frames:v", "1", "-vf", "scale=-2:360", f)
        frames.append(f)
    args = ["ffmpeg", "-y"]
    for f in frames:
        args += ["-i", f]
    args += ["-filter_complex", "".join(f"[{i}:v]" for i in range(len(frames))) + f"hstack=inputs={len(frames)}", "-q:v", "3", dest]
    sh(*args)
    for f in frames:
        os.remove(f)
    return dest


def review(sheet, meta):
    img = base64.b64encode(open(sheet, "rb").read()).decode()
    prompt = (
        f"This is a contact sheet of 5 frames (left to right, in time order) from a clip exported from a YouTube video. "
        f"The clip file is {meta['width']}x{meta['height']}; the YouTube source's aspect ratio is about {meta['src_ar']:.3f}:1 ({meta['label']}). "
        "Answer each yes/no with one short reason:\n"
        "1. Is every frame real video content (not black, not a solid color, not a loading spinner, not garbled/corrupted)?\n"
        "2. Do people and objects have natural proportions (not horizontally or vertically stretched/squeezed)?\n"
        "3. Is the picture free of black bars that look added by the export (bars that are part of the original framing, e.g. a 4:3 film or a letterboxed widescreen source, are fine — say which)?\n"
        "4. Does the content change across the frames, as video should (not one frozen image), allowing for static talking-head shots?\n"
        "End with exactly one line: VERDICT: PASS or VERDICT: FAIL."
    )
    body = json.dumps({"model": REVIEW_MODEL, "max_tokens": 600, "messages": [{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img}},
        {"type": "text", "text": prompt}]}]}).encode()
    d = get_json("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"})
    text = "".join(c.get("text", "") for c in d["content"])
    return text, bool(re.search(r"VERDICT:\s*PASS", text))


def main():
    rows, failed = [], []
    for vid in sorted(os.listdir(OUT)):
        d = os.path.join(OUT, vid)
        clip, res = os.path.join(d, "clip.mp4"), os.path.join(d, "result.json")
        if not (os.path.isfile(clip) and os.path.isfile(res)):
            continue
        r = json.load(open(res))
        rng = r["range"]
        want = rng["out"] - rng["in"]
        checks = []
        add = lambda n, ok, det: checks.append({"name": n, "ok": bool(ok), "detail": det})

        m = probe(clip)
        m["src_ar"], m["label"] = source_ar(vid), r["ar"]
        add("length matches Start/End (±0.5 s)", abs(m["duration"] - want) <= 0.5, f"file {m['duration']:.2f} s vs range {want:.2f} s")
        add("aspect ratio matches source (±3%)", abs(m["dar"] / m["src_ar"] - 1) <= 0.03,
            f"{m['width']}x{m['height']} = {m['dar']:.3f} vs source {m['src_ar']:.3f} ({r['ar']})")
        add("video resolution", m["height"] >= 240, f"{m['width']}x{m['height']} {m['vcodec']} {m['fps']} fps")
        loud = lufs(clip) if m["audio"] else None
        add("audio present and audible (> -40 LUFS)", m["audio"] and loud is not None and loud > -40, f"{m['acodec']} {loud} LUFS")
        br = black_ratio(clip, m["duration"])
        add("not mostly black (< 20% black)", br < 0.2, f"{br:.0%} black")

        lines = get_json(f"{SITE}/api/transcript/{vid}")
        # Site text around Start/End, spaces removed: Apify sometimes glues words
        # where caption lines join ("allcreate"), so match by substring.
        window = "".join(l["text"] for l in lines if rng["in"] - 8 <= l["start"] <= rng["out"] + 2)
        window = "".join(words(window))
        heard = transcribe(clip, d)
        open(os.path.join(d, "clip-transcript.txt"), "w").write(heard)
        hw = [w for w in words(heard) if len(w) >= 3]
        precision = sum(w in window for w in hw) / len(hw) if hw else None
        # Control: the same words against a far-away stretch of the transcript.
        far = [l for l in lines if abs(l["start"] - rng["in"]) > (rng["out"] - rng["in"]) + 60]
        far_text = "".join(words("".join(l["text"] for l in far[: max(1, len(window) // 40)])))
        control = sum(w in far_text for w in hw) / len(hw) if hw and far_text else None
        recall = precision
        add("speech in clip is the site transcript at Start/End (≥ 70% of heard words)",
            precision is not None and precision >= 0.7,
            f"{precision:.0%} of {len(hw)} heard words in the Start/End text"
            + (f"; control (far-away text) {control:.0%}" if control is not None else "") if precision is not None else "no speech heard")

        sheet = contact_sheet(clip, m["duration"], os.path.join(d, "contact-sheet.jpg"))
        verdict_text, ok = review(sheet, m)
        open(os.path.join(d, "review.txt"), "w").write(verdict_text)
        add(f"independent picture review ({REVIEW_MODEL})", ok, verdict_text.strip().splitlines()[-1])

        for c in checks:
            print(f"[{vid}] {'PASS' if c['ok'] else 'FAIL'} {c['name']} — {c['detail']}")
            if not c["ok"]:
                failed.append(f"{vid}: {c['name']} — {c['detail']}")
        rows.append({"id": vid, "media": m, "lufs": loud, "recall": recall, "heard": heard[:400], "checks": checks})
        json.dump(rows[-1], open(os.path.join(d, "media.json"), "w"), indent=2)
    json.dump(rows, open(os.path.join(OUT, "media-summary.json"), "w"), indent=2)
    print(f"\n{len(rows)} clips, {sum(len(r['checks']) for r in rows)} checks, {len(failed)} failed")
    for f in failed:
        print("FAIL " + f)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
