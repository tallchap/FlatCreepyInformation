#!/usr/bin/env python3
"""
yt-dlp fallback for Snippysaurus videos: download from YouTube at the best
resolution up to 1080p and upload straight to Bunny Stream.

Use it after scripts/ingest-batch.ts for any video the RapidAPI/GCS paths
didn't get to 1080p. Meant to run on Shadow (residential IP, so YouTube doesn't
bot-block it the way it does cloud IPs). Standard library only; needs yt-dlp
and ffprobe on PATH.

For each ID it:
  1. Lists the Bunny assets titled with that ID.
  2. Skips it if a finished asset is already 1080p+, or if an asset is still
     processing and is younger than --stale-min minutes.
  3. Asks YouTube for the best available height. Skips if Bunny already has
     that height (e.g. the source is only 720p).
  4. Downloads best <=1080p as mp4, checks the height with ffprobe.
  5. Creates a Bunny video titled <ID>, PUTs the file, waits for the encode.
  6. Once Bunny says it's finished: deletes the local file and every older
     asset for that ID (failed, stuck or lower-res), so clip lookup only ever
     finds one.

Usage:
  BUNNY_STREAM_API_KEY=... python3 scripts/ytdlp-to-bunny.py --ids ids.txt [--dry-run]
  python -X utf8 scripts\\ytdlp-to-bunny.py --ids ids.txt --workdir C:\\ytdlp-bunny

ids.txt: one YouTube ID or URL per line (# comments allowed).
Writes <workdir>/ytdlp-to-bunny-report.json with one entry per ID.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

LIBRARY_ID = "627230"
API = f"https://video.bunnycdn.com/library/{LIBRARY_ID}/videos"
URL_ID_RE = re.compile(r"(?:v=|youtu\.be/|shorts/|live/)([A-Za-z0-9_-]{11})")
BARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def log(msg):
    print(f"{datetime.now().strftime('%H:%M:%S')} {msg}", flush=True)


def bunny(method, url, key, body=None, headers=None, timeout=60):
    h = {"AccessKey": key, "Accept": "application/json"}
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def bunny_upload(guid, path, key):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        req = urllib.request.Request(
            f"{API}/{guid}",
            data=f,
            method="PUT",
            headers={"AccessKey": key, "Content-Type": "application/octet-stream", "Content-Length": str(size)},
        )
        with urllib.request.urlopen(req, timeout=3600) as r:
            return r.status


def assets_for(video_id, key):
    data = bunny("GET", f"{API}?search={video_id}&itemsPerPage=20", key)
    return [a for a in data.get("items", []) if a.get("title") == video_id]


def age_min(asset):
    d = asset.get("dateUploaded") or ""
    try:
        t = datetime.fromisoformat(d.replace("Z", "")).replace(tzinfo=timezone.utc)
    except ValueError:
        return 1e9
    return (datetime.now(timezone.utc) - t).total_seconds() / 60


def run(cmd, capture=False):
    r = subprocess.run(cmd, capture_output=capture, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        tail = (r.stderr or "").strip().splitlines()[-3:] if capture else []
        raise RuntimeError(f"{cmd[0]} exited {r.returncode}: {' | '.join(tail)}")
    return r.stdout if capture else ""


def video_height(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height",
               "-of", "csv=p=0", path], capture=True)
    return int(out.strip() or 0)


def process(video_id, args, key, workdir):
    entry = {"video_id": video_id}
    assets = assets_for(video_id, key)
    ready = [a for a in assets if a.get("status") == 4]
    best_ready = max([a.get("height") or 0 for a in ready], default=0)
    live = [a for a in assets if 0 <= (a.get("status") or 0) <= 3 and age_min(a) < args.stale_min]
    entry["bunny_before"] = [{"guid": a["guid"], "status": a.get("status"), "height": a.get("height")} for a in assets]

    if best_ready >= 1080:
        return {**entry, "result": "skip-already-1080", "height": best_ready}
    if live:
        return {**entry, "result": "skip-still-processing"}

    url = f"https://www.youtube.com/watch?v={video_id}"
    cookies = ["--cookies-from-browser", args.cookies_from_browser] if args.cookies_from_browser else []
    info = json.loads(run(["yt-dlp", "--ignore-config", *cookies, "-J", "--no-warnings", url], capture=True))
    source_max = max([f.get("height") or 0 for f in info.get("formats", [])
                      if f.get("vcodec") not in (None, "none")], default=0)
    target = min(1080, source_max)
    entry["youtube_max_height"] = source_max
    if best_ready and best_ready >= target:
        return {**entry, "result": "skip-youtube-has-nothing-better", "height": best_ready}
    if args.dry_run:
        return {**entry, "result": "would-download", "target_height": target}

    out = os.path.join(workdir, f"{video_id}.mp4")
    if os.path.exists(out):
        os.remove(out)
    log(f"[{video_id}] yt-dlp {target}p (Bunny has {best_ready or 'nothing'})")
    run(["yt-dlp", "--ignore-config", *cookies, "--no-warnings", "--no-playlist", "--no-progress",
         "-f", "bv*[height<=1080]+ba/b[height<=1080]",
         "-S", "res,vcodec:h264,acodec:m4a",
         "--merge-output-format", "mp4",
         "-o", out, url])
    got = video_height(out)
    size_mb = round(os.path.getsize(out) / 1e6)
    entry.update({"downloaded_height": got, "downloaded_mb": size_mb})
    if got < target:
        raise RuntimeError(f"downloaded {got}p but YouTube lists {target}p")

    guid = bunny("POST", API, key, body={"title": video_id})["guid"]
    entry["new_guid"] = guid
    log(f"[{video_id}] uploading {size_mb} MB to Bunny {guid}")
    bunny_upload(guid, out, key)

    duration = info.get("duration") or 3600
    deadline = time.time() + max(30, min(240, duration / 60 * 2)) * 60
    done = None
    while time.time() < deadline:
        time.sleep(30)
        v = bunny("GET", f"{API}/{guid}", key)
        if v.get("status") == 4:
            done = v
            break
        if v.get("status") in (5, 6):
            raise RuntimeError(f"Bunny encode failed (status {v.get('status')}); local file kept at {out}")
    if not done:
        entry["local_file_kept"] = out
        return {**entry, "result": "uploaded-still-encoding"}

    os.remove(out)
    removed = []
    for old in assets:
        try:
            bunny("DELETE", f"{API}/{old['guid']}", key)
            removed.append(old["guid"])
        except urllib.error.HTTPError as e:
            log(f"[{video_id}] could not delete old asset {old['guid']}: {e}")
    log(f"[{video_id}] DONE {done.get('height')}p, removed {len(removed)} old asset(s), local file deleted")
    return {**entry, "result": "done", "height": done.get("height"), "removed_guids": removed, "local_file_deleted": True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", required=True)
    ap.add_argument("--workdir", default=os.path.join(tempfile.gettempdir(), "ytdlp-to-bunny"))
    ap.add_argument("--stale-min", type=float, default=120,
                    help="treat a still-processing Bunny asset older than this as dead")
    ap.add_argument("--cookies-from-browser", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = os.environ.get("BUNNY_STREAM_API_KEY", "").strip()
    if not key:
        sys.exit("BUNNY_STREAM_API_KEY is not set")
    for tool in ("yt-dlp", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH")

    ids = []
    for line in open(args.ids, encoding="utf-8"):
        line = line.split("#", 1)[0].strip()
        m = URL_ID_RE.search(line)
        vid = m.group(1) if m else (line if BARE_ID_RE.match(line) else None)
        if vid and vid not in ids:
            ids.append(vid)
    os.makedirs(args.workdir, exist_ok=True)
    log(f"{len(ids)} IDs, workdir {args.workdir}{' (dry run)' if args.dry_run else ''}")

    report = []
    for vid in ids:
        try:
            e = process(vid, args, key, args.workdir)
        except Exception as ex:  # keep going; the report records the failure
            e = {"video_id": vid, "result": "failed", "error": str(ex)}
        if e["result"] not in ("skip-already-1080",):
            log(f"[{vid}] {e['result']} {e.get('height') or e.get('target_height') or ''} {e.get('error', '')}".rstrip())
        report.append(e)

    path = os.path.join(args.workdir, "ytdlp-to-bunny-report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    counts = {}
    for e in report:
        counts[e["result"]] = counts.get(e["result"], 0) + 1
    log(f"SUMMARY {counts}  report: {path}")
    sys.exit(1 if counts.get("failed") else 0)


if __name__ == "__main__":
    main()
