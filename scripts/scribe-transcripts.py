#!/usr/bin/env python3
"""English transcripts for videos with no usable captions: yt-dlp audio -> ElevenLabs Scribe.

Non-English audio (Scribe's detected language) is skipped. Writes <out>/<videoId>.json in fetchYoutubeTranscript's shape so ingest-batch can use it:
  npx tsx scripts/ingest-batch.ts --ids ids.txt --speaker "..." --only transcripts --transcripts-dir <out>

Run from a residential IP (Mac or Shadow); YouTube blocks cloud IPs. Needs yt-dlp and
ELEVENLABS_API_KEY_PRO (or ELEVENLABS_API_KEY) in .env.local. Skips IDs already in <out>.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import requests

STT = 'https://api.elevenlabs.io/v1/speech-to-text'


def env_key():
    env = dict(l.split('=', 1) for l in Path('.env.local').read_text().splitlines() if '=' in l and not l.startswith('#'))
    key = env.get('ELEVENLABS_API_KEY_PRO') or env.get('ELEVENLABS_API_KEY')
    if not key:
        sys.exit('ELEVENLABS_API_KEY(_PRO) missing from .env.local')
    return key.strip().strip('"\'')


def segments(words, max_words=25, max_secs=12.0):
    """Group Scribe words into caption-sized segments, breaking at sentence ends."""
    out, cur = [], []
    for w in words:
        if w.get('type') != 'word':
            continue
        cur.append(w)
        text = w['text']
        if re.search(r'[.?!]$', text) or len(cur) >= max_words or cur[-1]['end'] - cur[0]['start'] >= max_secs:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [{'text': ' '.join(w['text'] for w in seg), 'start': round(seg[0]['start'], 3), 'end': round(seg[-1]['end'], 3)}
            for seg in out]


def scribe(audio, key):
    for model in ('scribe_v2', 'scribe_v1'):
        with open(audio, 'rb') as f:
            r = requests.post(STT, headers={'xi-api-key': key}, timeout=3600,
                              data={'model_id': model, 'timestamps_granularity': 'word',
                                    'tag_audio_events': 'false'},
                              files={'file': (audio.name, f)})
        if r.ok:
            return model, r.json()
        if r.status_code not in (400, 404, 422):
            r.raise_for_status()
    r.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    a = ap.parse_args()
    key = env_key()
    a.out.mkdir(parents=True, exist_ok=True)
    ids = [l.split('#')[0].strip() for l in a.ids.read_text().splitlines() if l.split('#')[0].strip()]
    failed = []
    for vid in ids:
        dest = a.out/f'{vid}.json'
        if dest.exists():
            print(f'[{vid}] already done')
            continue
        try:
            with tempfile.TemporaryDirectory() as tmp:
                subprocess.run(['yt-dlp', '--ignore-config', '--no-warnings', '--socket-timeout', '30',
                                '-f', 'bestaudio[ext=m4a]/bestaudio', '-o', f'{tmp}/%(id)s.%(ext)s',
                                f'https://www.youtube.com/watch?v={vid}'], check=True, capture_output=True, text=True)
                audio = next(Path(tmp).iterdir())
                model, data = scribe(audio, key)
            if not str(data.get('language_code', '')).startswith('en'):
                raise RuntimeError(f"not English (Scribe detected {data.get('language_code')}); skipped")
            segs = segments(data.get('words', []))
            if not segs:
                raise RuntimeError('Scribe returned no words')
            dest.write_text(json.dumps({'video_id': vid, 'transcript_data': segs, 'language': 'English',
                                        'language_code': 'en', 'is_generated': True,
                                        '_source': f'elevenlabs-{model}',
                                        'detected_language': data.get('language_code')}, ensure_ascii=False))
            print(f'[{vid}] OK {model}: {len(segs)} segments, detected {data.get("language_code")}')
        except Exception as e:  # noqa: BLE001 — record and continue with the rest
            err = getattr(e, 'stderr', '') or str(e)
            print(f'[{vid}] FAILED: {str(err)[-300:]}')
            failed.append(vid)
    print(f'done: {len(ids) - len(failed)} ok, {len(failed)} failed {" ".join(failed)}')
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
