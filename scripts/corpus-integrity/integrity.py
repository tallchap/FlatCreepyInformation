#!/usr/bin/env python3
"""Snippy corpus integrity: one verifier plus gated, archived fixes.

    integrity.py snapshot                 inventory BigQuery, chat index, Bunny, YouTube
    integrity.py scan-duplicates          find re-uploads of one recording (transcript shingles)
    integrity.py check                    the verifier: checklist, exit 1 on any failure
    integrity.py fix <name> [--apply]     lengths | segments | duplicates | speakers | transcripts | windows

Every fix prints its plan and changes nothing without --apply. With --apply it
first archives every row and chat-file record it will touch to the permanent
`snippy_history.integrity_<date>_*` tables (and a local receipt), then makes the
change in one BigQuery transaction where it can. Fixes read a fresh snapshot,
so run `snapshot` (and `scan-duplicates` for duplicates) right before.
"""
import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.parse

import requests
from google.cloud import bigquery

import plan

PROJECT = 'youtubetranscripts-429803'
SOURCE = f'{PROJECT}.reptranscripts'
HISTORY = f'{PROJECT}.snippy_history'
SCRATCH = f'{PROJECT}.snippy_scratch'
STORE = 'vs_69b1015315d88191b6f26c169575bc4c'
BUNNY_LIBRARY = '627230'
GCS_BUCKET = 'snippysaurus-clips'
REPO = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('INTEGRITY_DIR', REPO / '.context' / 'corpus-integrity'))
SNAP = OUT / 'snapshot'
STAMP = dt.date.today().strftime('%Y%m%d')
# Committed: the verifier needs the evidence on any machine.
WAIVERS = Path(__file__).with_name('waivers.json')
# Every reptranscripts table keyed by video_id (INFORMATION_SCHEMA, 2026-10-04).
VIDEO_TABLES = ('youtube_videos', 'youtube_transcript_segments', 'segment_search_windows', 'video_descriptions',
                'tmp_video_descriptions', 'youtube_transcript_segments_sample10', 'transcribe_log',
                'transcription_failures', 'research_candidates', 'research_candidate_scores',
                'research_candidate_rejections', 'research_candidate_processing', 'research_processing_log',
                'research_transcript_logs') + plan.USER_CONTENT_TABLES


# ── plumbing ────────────────────────────────────────────────────────────────

def env():
    """.env.local first (BUNNY_STREAM_API_KEY, OPENAI_API_KEY), real env wins."""
    vals = {}
    path = REPO / '.env.local'
    if path.exists():
        for line in path.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    vals.update(os.environ)
    return vals


ENV = env()


def bq():
    key = ENV.get('GOOGLE_APPLICATION_CREDENTIALS', str(Path.home() / 'Desktop/ClaudeCode/gcp-service-account.json'))
    return bigquery.Client.from_service_account_json(key, project=PROJECT)


def q(b, sql, **params):
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter(k, 'STRING', v) if isinstance(v, (list, tuple))
        else bigquery.ScalarQueryParameter(k, 'STRING', v) for k, v in params.items()])
    return [dict(r) for r in b.query(sql, job_config=cfg).result()]


def save(name, data, folder=None):
    path = (folder or SNAP) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=1, default=str, ensure_ascii=False))
    tmp.replace(path)
    return path


def load(name, folder=None):
    return json.loads(((folder or SNAP) / name).read_text())


def openai(method, path, **kw):
    for attempt in range(5):
        r = requests.request(method, 'https://api.openai.com/v1' + path, timeout=60,
                             headers={'Authorization': f"Bearer {ENV['OPENAI_API_KEY']}", 'OpenAI-Beta': 'assistants=v2'}, **kw)
        if r.status_code in (429, 500, 502, 503) and attempt < 4:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        return r.json()


def bunny(method, path):
    r = requests.request(method, f'https://video.bunnycdn.com/library/{BUNNY_LIBRARY}{path}',
                         headers={'AccessKey': ENV['BUNNY_STREAM_API_KEY']}, timeout=60)
    r.raise_for_status()
    return r.json() if r.content else {}


def gcs_session():
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account
    key = ENV.get('GOOGLE_APPLICATION_CREDENTIALS', str(Path.home() / 'Desktop/ClaudeCode/gcp-service-account.json'))
    creds = service_account.Credentials.from_service_account_file(
        key, scopes=['https://www.googleapis.com/auth/devstorage.read_write'])
    return AuthorizedSession(creds)


def app_ops(*args):
    """Run app-ops.ts; returns its per-ID JSON lines."""
    res = subprocess.run(['npx', '-y', 'tsx', str(Path(__file__).with_name('app-ops.ts')), *args],
                         cwd=REPO, capture_output=True, text=True)
    out = [json.loads(l) for l in res.stdout.splitlines() if l.startswith('{')]
    if res.returncode not in (0, 1) or not out:
        raise RuntimeError(f'app-ops {args[0]} failed:\n{res.stderr[-2000:]}')
    return out


def archive(b, fix, table, ids):
    """Copy every row of `table` for these IDs into a permanent history table, verified by count."""
    dest = f'{HISTORY}.integrity_{STAMP}_{fix}_{table}'
    ds = bigquery.Dataset(HISTORY)
    ds.location = 'US'
    b.create_dataset(ds, exists_ok=True)
    b.query(f'CREATE TABLE IF NOT EXISTS `{dest}` AS SELECT * FROM `{SOURCE}.{table}` WHERE FALSE').result()
    src = q(b, f'SELECT COUNT(*) n FROM `{SOURCE}.{table}` WHERE video_id IN UNNEST(@ids)', ids=ids)[0]['n']
    have = q(b, f'SELECT COUNT(*) n FROM `{dest}` WHERE video_id IN UNNEST(@ids)', ids=ids)[0]['n']
    if have == 0 and src:
        q(b, f'INSERT INTO `{dest}` SELECT * FROM `{SOURCE}.{table}` WHERE video_id IN UNNEST(@ids)', ids=ids)
        have = q(b, f'SELECT COUNT(*) n FROM `{dest}` WHERE video_id IN UNNEST(@ids)', ids=ids)[0]['n']
    if have < src:
        raise RuntimeError(f'archive of {table} incomplete: {have}/{src}')
    print(f'  archived {src} {table} rows → {dest}')
    return dest


def archive_files(b, fix, files):
    """Record detached chat files (id + full attributes) so each can be re-attached."""
    if not files:
        return
    dest = f'{HISTORY}.integrity_{STAMP}_{fix}_chat_files'
    rows = [{'file_id': f['id'], 'video_id': f['attributes'].get('video_id'),
             'attributes_json': json.dumps(f['attributes'], ensure_ascii=False)} for f in files]
    schema = [bigquery.SchemaField(k, 'STRING') for k in rows[0]]
    b.load_table_from_json(rows, dest, job_config=bigquery.LoadJobConfig(
        schema=schema, write_disposition='WRITE_APPEND')).result()
    save(f'{fix}-chat-files-{int(time.time())}.json', rows, OUT / 'receipts')
    print(f'  archived {len(rows)} chat-file records → {dest}')


# ── snapshot ────────────────────────────────────────────────────────────────

def cmd_snapshot(_):
    b = bq()
    videos = q(b, f'''SELECT video_id, video_title, channel_name, CAST(published_date AS STRING) published_date,
                       video_length, speaker_source, CAST(created_time AS STRING) created_time FROM `{SOURCE}.youtube_videos`''')
    save('videos.json', videos)
    segs = q(b, f'''SELECT video_id, COUNT(*) rows_, COUNT(DISTINCT FORMAT('%d/%d', segment_index, line_index)) lines,
                     COUNT(DISTINCT created_at) ingests, MAX(COALESCE(end_sec, start_sec)) last_time,
                     COUNTIF(dup_text) conflicting
                   FROM (SELECT *, COUNT(DISTINCT text) OVER (PARTITION BY video_id, segment_index, line_index) > 1 dup_text
                         FROM `{SOURCE}.youtube_transcript_segments`) GROUP BY 1''')
    save('segments.json', segs)
    save('windows.json', q(b, f'SELECT video_id, COUNT(*) n FROM `{SOURCE}.segment_search_windows` GROUP BY 1'))
    owned = collections.Counter()
    for t in plan.USER_CONTENT_TABLES:
        for r in q(b, f'SELECT video_id, COUNT(*) n FROM `{SOURCE}.{t}` GROUP BY 1'):
            owned[r['video_id']] += r['n']
    save('user_content.json', owned)
    print(f'BigQuery: {len(videos)} video rows, {len(segs)} transcripts')

    files, after = [], None
    while True:
        page = openai('GET', f'/vector_stores/{STORE}/files', params={'limit': 100, **({'after': after} if after else {})})
        files += page['data']
        if not page.get('has_more'):
            break
        after = page['last_id']
    save('chat_files.json', [{'id': f['id'], 'status': f['status'], 'usage_bytes': f.get('usage_bytes'),
                              'attributes': f.get('attributes') or {}} for f in files])
    print(f'chat index: {len(files)} files')

    items, page = [], 1
    while True:
        d = bunny('GET', f'/videos?page={page}&itemsPerPage=1000&orderBy=date')
        items += d['items']
        if len(items) >= d['totalItems'] or not d['items']:
            break
        page += 1
    save('bunny.json', [{k: i.get(k) for k in ('guid', 'title', 'length', 'status')} for i in items])
    print(f'Bunny: {len(items)} videos')

    key = ENV.get('INTEGRITY_YOUTUBE_API_KEY') or ENV['YOUTUBE_API_KEY']
    ids = sorted({v['video_id'] for v in videos})
    yt = {}
    for i in range(0, len(ids), 50):
        r = requests.get('https://www.googleapis.com/youtube/v3/videos', timeout=60, params={
            'part': 'contentDetails,status', 'id': ','.join(ids[i:i + 50]), 'key': key})
        r.raise_for_status()
        for it in r.json().get('items', []):
            yt[it['id']] = {'seconds': iso_seconds(it['contentDetails']['duration']), 'privacy': it['status']['privacyStatus']}
    save('youtube.json', yt)
    print(f'YouTube: {len(yt)} of {len(ids)} still up')
    save('meta.json', {'taken_at': dt.datetime.now(dt.timezone.utc).isoformat()})


def iso_seconds(d):
    import re
    m = re.fullmatch(r'P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', d or '')
    if not m:
        return None
    days, h, mi, s = (int(x or 0) for x in m.groups())
    return days * 86400 + h * 3600 + mi * 60 + s


def cmd_scan_duplicates(_):
    """Sampled 7-word shingles per transcript; pairs sharing many rare shingles."""
    b = bq()
    ds = bigquery.Dataset(SCRATCH)
    ds.location = 'US'
    ds.default_table_expiration_ms = 2 * 86400 * 1000
    b.create_dataset(ds, exists_ok=True)
    # One row per word, then LEAD builds each 7-word phrase in a single sort per video.
    b.query(f'''CREATE OR REPLACE TABLE `{SCRATCH}.shingles` AS
      WITH seg AS (SELECT video_id, segment_index, text FROM `{SOURCE}.youtube_transcript_segments`
                   QUALIFY ROW_NUMBER() OVER (PARTITION BY video_id, segment_index, line_index ORDER BY created_at) = 1),
      words AS (SELECT video_id, segment_index, pos, w
                FROM seg, UNNEST(SPLIT(REGEXP_REPLACE(LOWER(text), r"[^a-z0-9' ]+", ' '), ' ')) w WITH OFFSET pos
                WHERE w != ''),
      grams AS (SELECT video_id, FARM_FINGERPRINT(CONCAT(w, ' ',
                  LEAD(w, 1) OVER o, ' ', LEAD(w, 2) OVER o, ' ', LEAD(w, 3) OVER o, ' ',
                  LEAD(w, 4) OVER o, ' ', LEAD(w, 5) OVER o, ' ', LEAD(w, 6) OVER o)) h
                FROM words WINDOW o AS (PARTITION BY video_id ORDER BY segment_index, pos))
      SELECT DISTINCT video_id, h FROM grams WHERE h IS NOT NULL AND MOD(ABS(h), 8) = 0''').result()
    # Phrases shared by more than 6 videos are boilerplate (intros, sponsor reads), not evidence.
    pairs = q(b, f'''WITH df AS (SELECT h FROM `{SCRATCH}.shingles` GROUP BY h HAVING COUNT(*) BETWEEN 2 AND 6),
        s AS (SELECT video_id, h FROM `{SCRATCH}.shingles` JOIN df USING (h)),
        sizes AS (SELECT video_id, COUNT(*) n FROM `{SCRATCH}.shingles` GROUP BY 1)
      SELECT a.video_id va, b.video_id vb, COUNT(*) shared, ANY_VALUE(sa.n) na, ANY_VALUE(sb.n) nb
      FROM s a JOIN s b ON a.h = b.h AND a.video_id < b.video_id
      JOIN sizes sa ON sa.video_id = a.video_id JOIN sizes sb ON sb.video_id = b.video_id
      GROUP BY 1, 2 HAVING shared >= 10 AND shared / LEAST(ANY_VALUE(sa.n), ANY_VALUE(sb.n)) >= 0.2''')
    save('duplicate_pairs.json', pairs)
    print(f'{len(pairs)} candidate pairs')


# ── shared views over the snapshot ──────────────────────────────────────────

def corpus():
    videos = {v['video_id']: v for v in load('videos.json')}
    rows = collections.Counter(v['video_id'] for v in load('videos.json'))
    files = collections.defaultdict(list)
    for f in load('chat_files.json'):
        files[f['attributes'].get('video_id')].append(f)
    return {
        'videos': videos, 'video_rows': rows, 'files': files,
        'segments': {s['video_id']: s for s in load('segments.json')},
        'windows': {w['video_id']: w['n'] for w in load('windows.json')},
        'bunny': bunny_by_video(load('bunny.json'), set(videos)),
        'youtube': load('youtube.json'),
        'owned': load('user_content.json'),
    }


def bunny_by_video(items, vids):
    """Bunny item per video. Titles are the YouTube ID, sometimes with a prefix
    ("Test Video <id>"); the site's lookup is a title search, so an embedded ID counts."""
    import re
    out = {}
    for i in items:
        title = (i['title'] or '').strip()
        hits = [title] if title in vids else [t for t in re.findall(r'[\w-]{11}', title) if t in vids]
        key = hits[0] if len(hits) == 1 else title
        if key not in out or (i.get('status') == 4 and out[key].get('status') != 4):
            out[key] = i
    return out


def true_seconds(c, vid):
    yt = (c['youtube'].get(vid) or {}).get('seconds')
    return yt or (c['bunny'].get(vid) or {}).get('length') or None


def duplicate_groups(c):
    path = SNAP / 'duplicate_pairs.json'
    if not path.exists():
        return None
    confirmed = [(p['va'], p['vb']) for p in load('duplicate_pairs.json')
                 if p['va'] in c['videos'] and p['vb'] in c['videos']
                 and plan.is_same_recording(p, true_seconds(c, p['va']), true_seconds(c, p['vb']))]
    return plan.group_duplicates(confirmed)


def duplicate_plan(c):
    out = []
    for g in duplicate_groups(c) or []:
        info = {v: {'user_content': c['owned'].get(v, 0), 'bunny': v in c['bunny'], 'on_youtube': v in c['youtube'],
                    'published': c['videos'][v]['published_date'], 'segments': c['segments'].get(v, {}).get('lines', 0)}
                for v in g}
        survivor, losers, why = plan.choose_survivor(g, info)
        out.append({'group': g, 'survivor': survivor, 'losers': losers, 'why': why,
                    'speaker_source': plan.merged_speakers(g, survivor, {v: c['videos'][v]['speaker_source'] for v in g})
                    if survivor else None,
                    'titles': {v: c['videos'][v]['video_title'] for v in g}})
    return out


def truncated(c):
    out = []
    for vid, s in c['segments'].items():
        secs = true_seconds(c, vid)
        cov = plan.coverage(s['last_time'], secs)
        if secs and secs >= 120 and cov is not None and cov < plan.MIN_COVERAGE:
            out.append({'video_id': vid, 'seconds': secs, 'coverage': round(cov, 3)})
    return out


def waived():
    """Videos a fix already re-fetched without finding a better transcript (with reason)."""
    return json.loads(WAIVERS.read_text()) if WAIVERS.exists() else {}


# ── the verifier ────────────────────────────────────────────────────────────

def cmd_check(args):
    c = corpus()
    meta = load('meta.json')
    checks = []

    def add(name, bad, total, detail=''):
        checks.append({'check': name, 'ok': not bad, 'bad': len(bad), 'of': total, 'examples': sorted(bad)[:5], 'detail': detail})

    vids = set(c['videos'])
    add('one youtube_videos row per video', [v for v, n in c['video_rows'].items() if n > 1], len(vids))
    add('every video has a transcript', [v for v in vids if v not in c['segments']], len(vids))
    add('transcripts stored once (no repeated caption lines)',
        [v for v, s in c['segments'].items() if s['rows_'] != s['lines']], len(c['segments']))
    add('search windows: one per caption line',
        [v for v, s in c['segments'].items() if c['windows'].get(v) != s['lines']], len(c['segments']))
    add('no search windows for deleted videos', [v for v in c['windows'] if v not in vids], len(c['windows']))
    add('chat index holds exactly the BigQuery videos',
        sorted((vids - set(c['files'])) | (set(c['files']) - vids - {None})), len(vids))
    add('every chat file is tagged with a video', ['(untagged)'] * len(c['files'].get(None, [])), sum(map(len, c['files'].values())))
    stale, missing, extra = [], [], []
    for v in vids:
        s, m, e = plan.speaker_plan(c['videos'][v]['speaker_source'],
                                    [{'file_id': f['id'], 'speaker': f['attributes'].get('speaker', '')} for f in c['files'].get(v, [])])
        stale += [f'{v}:{x}' for x in s]
        missing += [f'{v}:{x}' for x in m]
        extra += [f'{v}:{x}' for x in e]
    add('no chat files for speakers no longer on the video', stale, len(vids))
    add('every listed speaker has a chat file', missing, len(vids))
    add('one chat file per speaker per video', extra, len(vids))
    add('every chat file finished indexing',
        [f['id'] for fs in c['files'].values() for f in fs if f['status'] != 'completed'], sum(map(len, c['files'].values())))
    known = [v for v in vids if true_seconds(c, v)]
    add('stored video_length matches the real length',
        [v for v in known if plan.length_wrong(c['videos'][v]['video_length'], true_seconds(c, v))], len(known))
    add('chat duration_sec matches the real length',
        [f['id'] for v in known for f in c['files'].get(v, [])
         if abs((f['attributes'].get('duration_sec') or 0) - true_seconds(c, v)) > max(5, 0.03 * true_seconds(c, v))], len(known))
    w = waived()
    add('transcripts cover the whole video (or are waived)',
        [t['video_id'] for t in truncated(c) if t['video_id'] not in w], len(known), f'{len(w)} waived after re-fetch')
    dup = duplicate_plan(c)
    if dup is None:
        add('duplicate scan ran', ['(run scan-duplicates)'], 1)
    else:
        add('no re-uploads of the same recording', [d['group'][0] for d in dup], len(vids),
            f"{sum(1 for d in dup if not d['survivor'])} need a human")
    gone = [v for v in vids if v not in c['youtube']]
    bunny_orphans = [t for t in c['bunny'] if t not in vids]

    report = {'snapshot_taken_at': meta['taken_at'], 'checked_at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'videos': len(vids), 'chat_files': sum(map(len, c['files'].values())), 'bunny_videos': len(c['bunny']),
              'passed': all(x['ok'] for x in checks), 'checks': checks,
              'info': {'videos no longer on YouTube': len(gone), 'Bunny videos with no transcript': len(bunny_orphans)}}
    save('check.json', report, OUT)
    print(f"snapshot {meta['taken_at'][:19]}Z · {len(vids)} videos · {report['chat_files']} chat files · {len(c['bunny'])} Bunny\n")
    for x in checks:
        mark = 'PASS' if x['ok'] else 'FAIL'
        tail = f"  e.g. {', '.join(map(str, x['examples']))}" if x['bad'] else ''
        print(f"{mark}  {x['check']}: {x['bad']}/{x['of']} bad{(' (' + x['detail'] + ')') if x['detail'] else ''}{tail}")
    print(f"\ninfo: {len(gone)} videos are no longer on YouTube (kept; Bunny/transcript still serve them)")
    print(f"info: {len(bunny_orphans)} Bunny videos have no transcript, so chat can't reach them (not deleted here)")
    print('\nALL CHECKS PASSED' if report['passed'] else '\nFAILED')
    sys.exit(0 if report['passed'] else 1)


# ── fixes ───────────────────────────────────────────────────────────────────

def rebuild_windows(b, ids):
    """Recompute search windows for these videos only, in one transaction."""
    if not ids:
        return
    q(b, f'''BEGIN TRANSACTION;
      DELETE FROM `{SOURCE}.segment_search_windows` WHERE video_id IN UNNEST(@ids);
      INSERT INTO `{SOURCE}.segment_search_windows` (video_id, segment_index, start_sec, window_text)
      SELECT video_id, segment_index, start_sec,
        CONCAT(COALESCE(LAG(text, 1) OVER w, ''), ' ', text, ' ', COALESCE(LEAD(text, 1) OVER w, ''))
      FROM (SELECT * FROM `{SOURCE}.youtube_transcript_segments` WHERE video_id IN UNNEST(@ids)
            QUALIFY ROW_NUMBER() OVER (PARTITION BY video_id, segment_index, line_index ORDER BY created_at) = 1)
      WINDOW w AS (PARTITION BY video_id ORDER BY segment_index);
      COMMIT TRANSACTION;''', ids=sorted(ids))
    print(f'  rebuilt search windows for {len(ids)} videos')


def detach(files):
    for f in files:
        try:
            openai('DELETE', f"/vector_stores/{STORE}/files/{f['id']}")
        except requests.HTTPError as e:
            if e.response.status_code != 404:
                raise


def chat_upload(jobs):
    if not jobs:
        return []
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
        json.dump(jobs, fh)
    out = app_ops('chat', '--jobs', fh.name)
    bad = [o for o in out if not o['ok']]
    print(f'  uploaded chat files for {len(out) - len(bad)}/{len(out)} videos' + (f'; failed: {bad}' if bad else ''))
    return out


def fix_lengths(c, b, apply):
    wrong = {v: plan.format_length(true_seconds(c, v)) for v in c['videos']
             if true_seconds(c, v) and plan.length_wrong(c['videos'][v]['video_length'], true_seconds(c, v))}
    attr_fix = [(f, true_seconds(c, v)) for v in c['videos'] if true_seconds(c, v) for f in c['files'].get(v, [])
                if abs((f['attributes'].get('duration_sec') or 0) - true_seconds(c, v)) > max(5, 0.03 * true_seconds(c, v))]
    print(f'video_length wrong on {len(wrong)} videos; chat duration_sec wrong on {len(attr_fix)} files')
    for v in list(wrong)[:5]:
        print(f"  {v}: {c['videos'][v]['video_length']} → {wrong[v]}")
    if not apply:
        return
    if wrong:
        archive(b, 'lengths', 'youtube_videos', list(wrong))
        pairs = [{'id': k, 'len': v} for k, v in wrong.items()]
        b.query(f'''UPDATE `{SOURCE}.youtube_videos` t SET video_length = u.len
                    FROM UNNEST(@rows) u WHERE t.video_id = u.id''', job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ArrayQueryParameter('rows', 'STRUCT', [bigquery.StructQueryParameter(
                None, bigquery.ScalarQueryParameter('id', 'STRING', p['id']),
                bigquery.ScalarQueryParameter('len', 'STRING', p['len'])) for p in pairs])])).result()
        print(f'  updated video_length on {len(wrong)} videos')
    archive_files(b, 'lengths', [f for f, _ in attr_fix])
    for f, secs in attr_fix:
        openai('POST', f"/vector_stores/{STORE}/files/{f['id']}", json={'attributes': {**f['attributes'], 'duration_sec': int(secs)}})
    print(f'  updated duration_sec on {len(attr_fix)} chat files')


def fix_segments(c, b, apply):
    doubled = sorted(v for v, s in c['segments'].items() if s['rows_'] != s['lines'])
    conflicting = [v for v in doubled if c['segments'][v]['conflicting']]
    print(f'{len(doubled)} transcripts stored more than once ({len(conflicting)} with differing text: skipped)')
    ids = [v for v in doubled if v not in conflicting]
    if not apply or not ids:
        return
    archive(b, 'segments', 'youtube_transcript_segments', ids)
    expect = sum(c['segments'][v]['lines'] for v in ids)
    q(b, f'''BEGIN TRANSACTION;
      CREATE TEMP TABLE keep AS SELECT * FROM `{SOURCE}.youtube_transcript_segments` WHERE video_id IN UNNEST(@ids)
        QUALIFY ROW_NUMBER() OVER (PARTITION BY video_id, segment_index, line_index ORDER BY created_at) = 1;
      DELETE FROM `{SOURCE}.youtube_transcript_segments` WHERE video_id IN UNNEST(@ids);
      INSERT INTO `{SOURCE}.youtube_transcript_segments` SELECT * FROM keep;
      ASSERT (SELECT COUNT(*) FROM `{SOURCE}.youtube_transcript_segments` WHERE video_id IN UNNEST(@ids)) = {expect}
        AS 'deduplicated line count differs from the snapshot';
      COMMIT TRANSACTION;''', ids=ids)
    print(f'  kept one copy of each caption line for {len(ids)} videos ({expect} lines)')
    rebuild_windows(b, ids)


def fix_duplicates(c, b, apply):
    dup = duplicate_plan(c)
    if dup is None:
        sys.exit('run scan-duplicates first')
    blocked = [d for d in dup if not d['survivor']]
    todo = [d for d in dup if d['survivor']]
    losers = sorted(l for d in todo for l in d['losers'])
    print(f'{len(dup)} recordings uploaded more than once: {len(todo)} to merge ({len(losers)} copies to delete), '
          f'{len(blocked)} left for a human')
    for d in todo:
        print(f"  keep {d['survivor']} ({d['why']}) · delete {', '.join(d['losers'])} · {d['titles'][d['survivor']][:60]}")
    for d in blocked:
        print(f"  HUMAN {d['group']} · {d['why']}")
    save('duplicate-plan.json', dup, OUT)
    if not apply or not todo:
        return
    if any(c['owned'].get(l) for l in losers):
        raise RuntimeError('a copy marked for deletion owns clips/exports')
    for t in VIDEO_TABLES:
        archive(b, 'duplicates', t, losers)
    archive(b, 'duplicates', 'youtube_videos', [d['survivor'] for d in todo])
    loser_files = [f for l in losers for f in c['files'].get(l, [])]
    archive_files(b, 'duplicates', loser_files)
    deletes = '\n'.join(f'DELETE FROM `{SOURCE}.{t}` WHERE video_id IN UNNEST(@losers);' for t in VIDEO_TABLES)
    b.query(f'''BEGIN TRANSACTION;
      UPDATE `{SOURCE}.youtube_videos` t SET speaker_source = u.s FROM UNNEST(@merged) u WHERE t.video_id = u.id;
      {deletes}
      ASSERT (SELECT COUNT(*) FROM `{SOURCE}.youtube_videos` WHERE video_id IN UNNEST(@losers)) = 0 AS 'copies remain';
      COMMIT TRANSACTION;''', job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter('losers', 'STRING', losers),
        bigquery.ArrayQueryParameter('merged', 'STRUCT', [bigquery.StructQueryParameter(
            None, bigquery.ScalarQueryParameter('id', 'STRING', d['survivor']),
            bigquery.ScalarQueryParameter('s', 'STRING', d['speaker_source'])) for d in todo])])).result()
    print(f'  deleted {len(losers)} copies from {len(VIDEO_TABLES)} tables; merged speakers into {len(todo)} survivors')
    detach(loser_files)
    print(f'  detached {len(loser_files)} chat files of deleted copies')
    for l in losers:
        if l in c['bunny']:
            bunny('DELETE', f"/videos/{c['bunny'][l]['guid']}")
            print(f'  deleted Bunny copy of {l}')
    s = gcs_session()
    for l in losers:
        r = s.delete(f"https://storage.googleapis.com/storage/v1/b/{GCS_BUCKET}/o/{urllib.parse.quote(f'videos/{l}.mp4', safe='')}")
        if r.status_code == 204:
            print(f'  deleted gs://{GCS_BUCKET}/videos/{l}.mp4')
        elif r.status_code != 404:
            r.raise_for_status()
    save(f'duplicates-applied-{int(time.time())}.json', todo, OUT / 'receipts')
    print('  survivors gain any speakers the deleted copies had: run `fix speakers` after a fresh snapshot')


def fix_speakers(c, b, apply):
    detach_files, jobs = [], []
    for v, video in c['videos'].items():
        fs = c['files'].get(v, [])
        stale, missing, extra = plan.speaker_plan(video['speaker_source'],
                                                  [{'file_id': f['id'], 'speaker': f['attributes'].get('speaker', '')} for f in fs])
        drop = set(stale) | set(extra)
        detach_files += [f for f in fs if f['id'] in drop]
        if missing:
            lang = next((f['attributes'].get('language') for f in fs if f['attributes'].get('language')), 'en')
            jobs.append({'videoId': v, 'onlySpeakers': missing, 'language': lang})
    orphans = [f for k, fs in c['files'].items() if k not in c['videos'] for f in fs]
    print(f'{len(detach_files)} chat files for speakers no longer listed or duplicated, '
          f'{sum(len(j["onlySpeakers"]) for j in jobs)} missing speaker files on {len(jobs)} videos, '
          f'{len(orphans)} files for videos not in BigQuery')
    for j in jobs[:10]:
        print(f"  add {j['videoId']}: {', '.join(j['onlySpeakers'])}")
    if not apply:
        return
    out = chat_upload(jobs)
    if any(not o['ok'] for o in out):
        raise RuntimeError('some uploads failed; nothing detached')
    archive_files(b, 'speakers', detach_files + orphans)
    detach(detach_files + orphans)
    print(f'  detached {len(detach_files) + len(orphans)} chat files')


def fix_transcripts(c, b, apply):
    w = waived()
    todo = [t for t in truncated(c) if t['video_id'] not in w]
    print(f'{len(todo)} transcripts end before {int(plan.MIN_COVERAGE * 100)}% of the video ({len(w)} already waived)')
    for t in todo:
        print(f"  {t['video_id']} covers {t['coverage']:.0%} of {plan.format_length(t['seconds'])}")
    if not apply or not todo:
        return
    work = OUT / 'refetch'
    ids_file = work / 'ids.txt'
    work.mkdir(parents=True, exist_ok=True)
    ids_file.write_text('\n'.join(t['video_id'] for t in todo))
    # Pass 1: the app's caption fetchers (Apify → proxy). Pass 2, only when the
    # captions themselves stop early: yt-dlp audio → ElevenLabs Scribe via
    # scripts/scribe-transcripts.py. A transcript that came back and covers no
    # more is waived with its evidence; a failed fetch is reported, never waived.
    better, best, failed = [], {}, []
    pending = todo
    for source in ('captions', 'audio'):
        if not pending:
            break
        folder = work / source
        ids_file.write_text('\n'.join(t['video_id'] for t in pending))
        fetched = fetch_captions(ids_file, folder) if source == 'captions' else fetch_audio(ids_file, folder)
        left = []
        for t in pending:
            o = fetched.get(t['video_id'], {})
            new = plan.coverage(o.get('last_time'), t['seconds']) if o.get('ok') else None
            if plan.should_replace_transcript(t['coverage'], new):
                better.append(t['video_id'])
                best[t['video_id']] = folder
                print(f"  {t['video_id']}: {t['coverage']:.0%} → {new:.0%} ({source}, {o.get('source')}) — replacing")
                continue
            t.setdefault('tried', []).append(f'{source}: ' + (o.get('error') or f'covers {new:.0%}'))
            t.setdefault('errors', 0)
            # Scribe path is English-only by design: a known limit, not a failure.
            t['errors'] += 0 if o.get('ok') or 'not English' in (o.get('error') or '') else 1
            left.append(t)
        pending = left
    for t in pending:
        if t['errors']:
            failed.append(t['video_id'])
            print(f"  {t['video_id']}: NOT FIXED — {'; '.join(t['tried'])}")
            continue
        reason = '; '.join(t['tried'])
        w[t['video_id']] = {'coverage': t['coverage'], 'reason': reason, 'at': dt.date.today().isoformat()}
        print(f"  {t['video_id']}: waived — {reason}")
    save(WAIVERS.name, w, WAIVERS.parent)
    if better:
        for table in ('youtube_videos', 'youtube_transcript_segments'):
            archive(b, 'transcripts', table, better)
        archive_files(b, 'transcripts', [f for v in better for f in c['files'].get(v, [])])
        out = []
        for folder in sorted(set(best.values())):
            ids_file.write_text('\n'.join(v for v in better if best[v] == folder))
            out += app_ops('replace', '--ids', str(ids_file), '--from', str(folder))
        bad = [o for o in out if not o['ok']]
        print(f'  replaced {len(out) - len(bad)}/{len(out)} transcripts' + (f'; failed: {bad}' if bad else ''))
        rebuild_windows(b, [o['id'] for o in out if o['ok']])


def fetch_captions(ids_file, folder):
    return {o['id']: o for o in app_ops('fetch', '--ids', str(ids_file), '--out', str(folder))}


def fetch_audio(ids_file, folder):
    """scripts/scribe-transcripts.py → folder/<id>.json; per-ID result from its log."""
    import re
    res = subprocess.run([sys.executable, str(REPO / 'scripts' / 'scribe-transcripts.py'), '--ids', str(ids_file),
                          '--out', str(folder)], cwd=REPO, capture_output=True, text=True)
    out = {}
    for vid in ids_file.read_text().split():
        path = folder / f'{vid}.json'
        if path.exists():
            t = json.loads(path.read_text())
            segs = t.get('transcript_data') or []
            out[vid] = {'id': vid, 'ok': bool(segs), 'source': t.get('_source'),
                        'last_time': max((s.get('end') or s.get('start') or 0) for s in segs) if segs else 0}
        else:
            m = re.search(rf'\[{re.escape(vid)}\] FAILED: (.*)', res.stdout)
            out[vid] = {'id': vid, 'ok': False, 'error': (m.group(1) if m else res.stderr[-300:]).strip()}
    return out


def fix_windows(c, b, apply):
    bad = sorted(v for v, s in c['segments'].items() if c['windows'].get(v) != s['lines'])
    gone = sorted(v for v in c['windows'] if v not in c['videos'])
    print(f'{len(bad)} videos with wrong search windows, {len(gone)} deleted videos still in the window table')
    if not apply:
        return
    if gone:
        archive(b, 'windows', 'segment_search_windows', gone)
        q(b, f'DELETE FROM `{SOURCE}.segment_search_windows` WHERE video_id IN UNNEST(@ids)', ids=gone)
    rebuild_windows(b, bad)


FIXES = {'lengths': fix_lengths, 'segments': fix_segments, 'duplicates': fix_duplicates,
         'speakers': fix_speakers, 'transcripts': fix_transcripts, 'windows': fix_windows}


def cmd_fix(args):
    c, b = corpus(), bq()
    print(f"[{'APPLY' if args.apply else 'dry run'}] {args.name} — snapshot {load('meta.json')['taken_at'][:19]}Z")
    FIXES[args.name](c, b, args.apply)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('snapshot').set_defaults(fn=cmd_snapshot)
    sub.add_parser('scan-duplicates').set_defaults(fn=cmd_scan_duplicates)
    sub.add_parser('check').set_defaults(fn=cmd_check)
    f = sub.add_parser('fix')
    f.add_argument('name', choices=FIXES)
    f.add_argument('--apply', action='store_true')
    f.set_defaults(fn=cmd_fix)
    args = p.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
