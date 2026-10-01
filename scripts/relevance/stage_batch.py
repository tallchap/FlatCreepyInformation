#!/usr/bin/env python3
"""Stage a youtube-research-server batch for the Luna check without touching the Snippy database.

  manifest  split the batch CSV into keep-list / already-in-DB / culled / Luna candidates
  fetch     load each candidate's transcript from the YRS DynamoDB table, falling back to the
            Vercel proxy, then Apify, for missing or dubbed transcripts (English check), cached per video
  build     write inputs.jsonl in audit.py's snapshot format, so `audit.py run` works unchanged
  select    after `audit.py run`: write upload lists (everything except no_passage)

BigQuery is only read (which IDs already exist). Nothing is written to BigQuery, Bunny or the
vector store.
"""
import argparse
import collections
import concurrent.futures
import csv
import datetime as dt
import json
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audit  # noqa: E402

CULL_CSV = Path.home()/'conductor/workspaces/flatcreepyinformation-v1/chicago/.context/cull-20260930/audit-no-clipworthy-passage.csv'
DYNAMO_TABLE = 'youtube_research_transcripts'
PROXY = 'https://afraid-sparkling-planes.vercel.app/transcript'
# Scripts YouTube auto-dubs into. Apify's actor has no language input and sometimes returns
# a dub (Arabic for English Tegmark videos on 2026-10-01).
NON_LATIN = re.compile(r'[֐-ۿЀ-ӿऀ-ॿ฀-๿぀-ヿ㐀-鿿가-힯]')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def load_batch(path):
    with open(path, encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def in_database(ids):
    from google.cloud import bigquery
    q = f'SELECT DISTINCT video_id FROM `{audit.SOURCE}.youtube_videos` WHERE video_id IN UNNEST(@ids)'
    cfg = bigquery.QueryJobConfig(query_parameters=[bigquery.ArrayQueryParameter('ids', 'STRING', sorted(ids))])
    return {r.video_id for r in audit.bq_client().query(q, job_config=cfg).result()}


def is_kept(rows):
    """A video is on the keep list if any listed speaker or its title/channel matches it."""
    found = {}
    for r in rows:
        for name, fields in audit.protected({'speaker': r['speaker'], 'title': r['title'], 'publisher': r['channel']}).items():
            found.setdefault(name, sorted(set(found.get(name, []) + fields)))
    return found


def manifest(run, batch_csv, cull_csv):
    rows = load_batch(batch_csv)
    by_video = collections.OrderedDict()
    for r in rows:
        by_video.setdefault(r['video_id'], []).append(r)
    with open(cull_csv, encoding='utf-8-sig') as f:
        culled = {r['video_id'] for r in csv.DictReader(f)}
    existing = in_database(by_video)
    groups = {'keep_new': {}, 'keep_in_db': {}, 'other_in_db': {}, 'culled': {}, 'luna': {}}
    for vid, vrows in by_video.items():
        kept = is_kept(vrows)
        speakers = [r['speaker'] for r in vrows]
        # Ingest speaker: a keep-list speaker when there is one, else the first listed.
        primary = next((s for s in speakers if audit.protected({'speaker': s})), speakers[0])
        entry = {'video_id': vid, 'speakers': speakers, 'primary_speaker': primary, 'title': vrows[0]['title'],
                 'channel': vrows[0]['channel'], 'pull_ids': sorted({r['pull_id'] for r in vrows}),
                 'keep_matches': kept, 'possible_reupload': any(r['possible_reupload'] for r in vrows)}
        if kept:
            group = 'keep_in_db' if vid in existing else 'keep_new'
        elif vid in existing:
            group = 'other_in_db'
        elif vid in culled:
            group = 'culled'
        else:
            group = 'luna'
        groups[group][vid] = entry
    run.mkdir(parents=True, exist_ok=True)
    audit.atomic(run/'manifest.json', {'created_at': now(), 'batch_csv': str(batch_csv), 'cull_csv': str(cull_csv),
                                        'keep_list': list(audit.PROTECTED),
                                        'counts': {k: len(v) for k, v in groups.items()}, 'groups': groups})
    lists = run/'lists'
    for group, entries in groups.items():
        per = collections.defaultdict(list)
        for e in entries.values():
            per[e['primary_speaker']].append(e['video_id'])
        for speaker, vids in per.items():
            p = lists/group/f'{slug(speaker)}.txt'
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(f'# {speaker} — {group}, {len(vids)} videos\n' + '\n'.join(vids) + '\n')
    print(json.dumps({k: len(v) for k, v in groups.items()}))


def english(segments):
    text = ' '.join(s['text'] for s in segments)
    letters = sum(c.isalpha() for c in text) or 1
    return len(NON_LATIN.findall(text))/letters < 0.2


def from_dynamo(table, pull_id, vid):
    from boto3.dynamodb.conditions import Key
    items, kw = [], {'KeyConditionExpression': Key('pull_id').eq(pull_id) & Key('video_id').begins_with(vid+'#seg#')}
    while True:
        resp = table.query(**kw)
        items += resp['Items']
        if 'LastEvaluatedKey' not in resp:
            break
        kw['ExclusiveStartKey'] = resp['LastEvaluatedKey']
    items.sort(key=lambda i: i['video_id'])
    return [{'start': float(i.get('start', 0)), 'end': float(i.get('end', 0)), 'text': str(i.get('text', ''))} for i in items]


def from_proxy(vid):
    import requests
    for attempt in range(3):
        try:
            r = requests.post(PROXY, json={'url': 'https://www.youtube.com/watch?v='+vid}, timeout=60)
            data = r.json()
            if data.get('transcript_data'):
                return [{'start': float(s['start']), 'end': float(s['start'])+float(s.get('duration') or 0), 'text': s['text']}
                        for s in data['transcript_data']], data.get('language_code')
            return None, data.get('error')
        except Exception as e:  # noqa: BLE001 — transient network/JSON errors retry
            err = str(e)
            time.sleep(2*(attempt+1))
    return None, err


def from_apify(vid):
    import requests
    token = next((l.split('=', 1)[1].strip().strip('"\'') for l in Path('.env.local').read_text().splitlines()
                  if l.startswith('APIFY_TOKEN=')), None) if Path('.env.local').exists() else None
    if not token:
        return None, 'no APIFY_TOKEN'
    try:
        r = requests.post('https://api.apify.com/v2/acts/scrape-creators~best-youtube-transcripts-scraper/run-sync-get-dataset-items',
                          params={'token': token, 'timeout': 240}, json={'videoUrls': ['https://www.youtube.com/watch?v='+vid]}, timeout=300)
        items = r.json()
        if items and items[0].get('transcript'):
            return [{'start': float(s['startMs'])/1000, 'end': float(s['endMs'])/1000, 'text': s['text']}
                    for s in items[0]['transcript']], items[0].get('language')
        return None, 'empty'
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def fetch_one(entry, out_dir, table):
    vid = entry['video_id']
    path = out_dir/f'{vid}.json'
    if path.exists():
        return json.loads(path.read_text())
    tried = []
    for pull in entry['pull_ids']:
        segs = from_dynamo(table, pull, vid)
        if segs and english(segs):
            rec = {'video_id': vid, 'source': f'yrs-dynamo:{pull}', 'segments': segs}
            audit.atomic(path, rec)
            return rec
        tried.append(f'dynamo:{pull}:' + ('non-english' if segs else 'empty'))
    segs, info = from_proxy(vid)
    if segs and english(segs):
        rec = {'video_id': vid, 'source': f'vercel-proxy:{info}', 'segments': segs, 'tried': tried}
        audit.atomic(path, rec)
        return rec
    tried.append('proxy:' + ('non-english' if segs else str(info)))
    segs, info = from_apify(vid)
    if segs and english(segs):
        rec = {'video_id': vid, 'source': f'apify:{info}', 'segments': segs, 'tried': tried}
        audit.atomic(path, rec)
        return rec
    tried.append('apify:' + ('non-english' if segs else str(info)))
    return {'video_id': vid, 'source': None, 'segments': [], 'tried': tried}


def fetch(run, workers):
    import boto3
    groups = json.loads((run/'manifest.json').read_text())['groups']
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(DYNAMO_TABLE)
    out_dir = run/'transcripts'
    out_dir.mkdir(parents=True, exist_ok=True)
    entries = list(groups['luna'].values())
    sources, failures = collections.Counter(), {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for i, rec in enumerate(pool.map(lambda e: fetch_one(e, out_dir, table), entries), 1):
            sources[(rec['source'] or 'missing').split(':')[0]] += 1
            if not rec['source']:
                failures[rec['video_id']] = rec['tried']
            if i % 100 == 0:
                print(json.dumps({'done': i, 'total': len(entries), **sources}), flush=True)
    audit.atomic(run/'fetch-summary.json', {'time': now(), 'candidates': len(entries), 'sources': sources, 'missing': failures})
    print(json.dumps({'candidates': len(entries), **sources}))


def seconds(x):
    # Same shape as BigQuery's CAST(FLOAT64 AS STRING): 12 not 12.0.
    return str(int(x)) if float(x).is_integer() else str(round(x, 3))


def build(run):
    """inputs.jsonl matching audit.snapshot(): same fields, dedupe and transcript line format."""
    groups = json.loads((run/'manifest.json').read_text())['groups']
    batch = collections.defaultdict(list)
    for r in load_batch(json.loads((run/'manifest.json').read_text())['batch_csv']):
        batch[r['video_id']].append(r)
    path = run/'inputs.jsonl'
    tmp = path.with_suffix('.jsonl.tmp')
    n = 0
    with tmp.open('w', encoding='utf-8') as f:
        for vid in sorted(groups['luna']):
            entry, first = groups['luna'][vid], batch[vid][0]
            tp = run/'transcripts'/f'{vid}.json'
            segs = json.loads(tp.read_text())['segments'] if tp.exists() else []
            seen = {}
            for s in segs:
                if s['text'].strip():
                    key = (s['start'], s['text'])
                    seen[key] = max(seen.get(key, s['end']), s['end'])
            ordered = sorted(seen.items(), key=lambda kv: (kv[0][0], kv[0][1]))
            row = {'video_id': vid, 'title': first['title'], 'publisher': first['channel'],
                   'published_at': first['published_at'], 'url': first['url'] or 'https://www.youtube.com/watch?v='+vid,
                   'video_length': round(float(first['duration_min'] or 0)*60),
                   'speaker_source': ', '.join(entry['speakers']), 'metadata_rows': len(batch[vid]),
                   'transcript': '\n'.join(f'[{seconds(k[0])}] {k[1]}' for k, _ in ordered) or None,
                   'plain_text': ' '.join(k[1] for k, _ in ordered) or None,
                   'last_timestamp': max((max(k[0], e) for k, e in ordered), default=None),
                   'segment_count': len(ordered) or None}
            row['protected_matches'] = audit.protected(row)
            row['input_hash'] = audit.digest(row)
            f.write(json.dumps(row, ensure_ascii=False, default=str)+'\n')
            n += 1
    tmp.replace(path)
    audit.atomic(run/'snapshot.json', {'created_at': now(), 'unique_videos': n, 'source': 'youtube-research-server batch (DynamoDB transcripts, Vercel proxy fallback)',
                                       'batch_csv': json.loads((run/'manifest.json').read_text())['batch_csv'],
                                       'prompt_source': audit.PROMPT_SOURCE, 'protected_speakers': list(audit.PROTECTED)})
    print(json.dumps({'inputs': n}))


UPLOAD = {'eligible', 'review', 'not_eligible', 'preserved'}


def select(run):
    m = json.loads((run/'manifest.json').read_text())
    results = {p.stem: json.loads(p.read_text()) for p in (run/'results').glob('*.json')}
    out = {'keep (upload directly)': list(m['groups']['keep_new']), 'luna pass (upload)': [], 'luna no_passage (drop)': [],
           'unassessed / error (no decision)': []}
    for vid in m['groups']['luna']:
        status = results.get(vid, {}).get('status', 'pending')
        key = 'luna pass (upload)' if status in UPLOAD else 'luna no_passage (drop)' if status == 'no_passage' else 'unassessed / error (no decision)'
        out[key].append(vid)
    entries = {**m['groups']['keep_new'], **m['groups']['luna']}
    lists = run/'lists'/'upload'
    per = collections.defaultdict(list)
    for vid in out['keep (upload directly)'] + out['luna pass (upload)']:
        per[entries[vid]['primary_speaker']].append(vid)
    for speaker, vids in per.items():
        p = lists/f'{slug(speaker)}.txt'
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f'# {speaker} — upload, {len(vids)} videos\n' + '\n'.join(vids) + '\n')
    with (run/'upload-decisions.csv').open('w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['video_id', 'decision', 'luna_status', 'primary_speaker', 'speakers', 'title', 'channel', 'url'])
        for decision, vids in out.items():
            for vid in vids:
                e = entries[vid]
                w.writerow([vid, decision, results.get(vid, {}).get('status', '' if vid in m['groups']['keep_new'] else 'pending'),
                            e['primary_speaker'], '; '.join(e['speakers']), e['title'], e['channel'], 'https://www.youtube.com/watch?v='+vid])
    counts = {k: len(v) for k, v in out.items()}
    audit.atomic(run/'upload-summary.json', {'time': now(), 'counts': counts,
                 'rule': 'Upload keep-list videos and every Luna status except no_passage (same rule as the 2026-09-30 cull).'})
    print(json.dumps(counts))
    return 0 if not out['unassessed / error (no decision)'] else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('command', choices=['manifest', 'fetch', 'build', 'select'])
    ap.add_argument('--run-dir', type=Path, required=True)
    ap.add_argument('--batch-csv', type=Path, default=Path.home()/'Desktop/ClaudeCode/ai-figures-yt-2024-present/all-videos-2024-present.csv')
    ap.add_argument('--cull-csv', type=Path, default=CULL_CSV)
    ap.add_argument('--workers', type=int, default=8)
    a = ap.parse_args()
    if a.command == 'manifest':
        manifest(a.run_dir, a.batch_csv, a.cull_csv)
    elif a.command == 'fetch':
        fetch(a.run_dir, a.workers)
    elif a.command == 'build':
        build(a.run_dir)
    else:
        return select(a.run_dir)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
