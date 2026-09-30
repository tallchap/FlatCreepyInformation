#!/usr/bin/env python3
"""Create a compact immutable evidence checkpoint; never upload or mutate a run.

Usage: python -X utf8 scripts/relevance/checkpoint_shadow.py --root RUN --output CHECKPOINTS
The output is a new timestamped directory. Media bytes, requests, embedded image
packages, logs and credentials are excluded. Original evidence paths stay intact;
locator-map.json maps them to archived relative locations.
"""
import argparse
from collections import Counter
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import uuid

import audit

MEDIA_SUFFIXES = {'.mp4', '.mov', '.webm', '.mkv', '.m4a', '.mp3', '.wav', '.flac', '.aac'}
ROOT_FILES = {'status.json', 'verification.json', 'checkpoint-import.json', 'checkpoint-paths.json',
              'checkpoint-status.json', 'runner-config.json', 'prior-verification.json',
              'astra-handoff-queue.json', 'astra-handoff-queue.md', 'production-report.json',
              'coverage.csv', 'code-verification.json', 'cuda-roundtrip-verification.json',
              'preflight-query.json', 'supervisor.json', 'experiment-plan.json',
              'experiment-status.json', 'benchmark-baseline.json',
              'benchmark-report.json', 'benchmark-report.md', 'benchmark-context.json'}
RENDER_FILES = {'recipe.json', 'parent-recipe.json', 'result.json', 'qa.json', 'final-qa.json',
                'source.json', 'source-ffprobe.json', 'transfer.json', 'trim.json',
                'contact.jpg', 'contact.png', 'clip.json', 'evidence.json'}
SECRET_KEYS = {'apikey', 'openaiapikey', 'privatekey', 'accesstoken',
               'refreshtoken', 'clientsecret', 'password', 'secretaccesskey'}


def stable_bytes(path):
    for _ in range(3):
        before = path.stat()
        data = path.read_bytes()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns):
            return data
    raise RuntimeError('Artifact changed repeatedly during snapshot: ' + str(path))


def reject_secrets(value):
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = re.sub(r'[^a-z]', '', str(key).lower())
            if normalized in SECRET_KEYS or (normalized == 'authorization' and
                    isinstance(item, str) and re.match(r'^(?:Bearer|Basic|Digest)\s', item, re.I)):
                raise ValueError('Credential-shaped field in checkpoint artifact; refusing to copy')
            reject_secrets(item)
    elif isinstance(value, list):
        for item in value:
            reject_secrets(item)
    elif isinstance(value, str) and ('-----BEGIN PRIVATE KEY-----' in value or
                                     re.search(r'\bsk-(?:proj|ant-api)\w*-', value)):
        raise ValueError('Credential-shaped value in checkpoint artifact; refusing to copy')


def json_bytes(data):
    return json.dumps(data, indent=2, ensure_ascii=False).encode('utf-8')


def selected(relative, candidate_ids):
    parts = list(relative.parts)
    if parts[0] == 'mac-checkpoint':
        parts = parts[1:]
    if not parts:
        return False
    name = parts[-1]
    if len(parts) == 1:
        return name in ROOT_FILES
    if parts[0] in {'records', 'publications', 'publication-attempts', 'recipes'}:
        return len(parts) == 2 and relative.suffix == '.json' and (parts[0] != 'records' or relative.stem in candidate_ids)
    if parts[0] == 'input':
        return (len(parts) == 2 and name in {'manifest.json', 'already-published.json'} or
                len(parts) == 3 and parts[1] == 'candidates' and relative.stem in candidate_ids and relative.suffix == '.json')
    if parts[0] in {'rendered', 'batches'}:
        if name in {'request.json', 'packages.json', 'response.json'}:
            return False
        if relative.suffix == '.md':
            return 'astra-escalations' in parts or name == 'astra-handoff-queue.md'
        if parts[0] == 'batches' and relative.suffix == '.json':
            return True
        if parts[0] == 'batches' and name == 'transport-events.jsonl':
            return True
        return name in RENDER_FILES
    return False


def usage_summary(raw):
    usage = raw.get('usage') or {}
    input_tokens = usage.get('input_tokens', 0)
    cached = (usage.get('input_tokens_details') or {}).get('cached_tokens', 0)
    writes = (usage.get('input_tokens_details') or {}).get('cache_write_tokens', 0)
    return {'input_tokens': input_tokens, 'cached_input_tokens': cached,
            'cache_write_tokens': writes, 'uncached_input_tokens': max(0, input_tokens - cached - writes),
            'output_tokens': usage.get('output_tokens', 0), 'total_tokens': usage.get('total_tokens', 0),
            'reasoning_tokens': (usage.get('output_tokens_details') or {}).get('reasoning_tokens', 0)}


def create_checkpoint(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    if not root.is_dir() or output.is_relative_to(root):
        raise ValueError('Root must exist and output must be outside the production root')
    output.mkdir(parents=True, exist_ok=True)
    started = audit.now()
    name = 'checkpoint-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8]
    staging, final = output / ('.' + name + '.incomplete'), output / name
    staging.mkdir()
    files, cached, manifest = {}, {}, []

    def capture(path):
        relative = path.relative_to(root).as_posix()
        if relative not in files:
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                raise ValueError('Artifact escapes the run root')
            files[relative] = stable_bytes(path)
        return files[relative]

    def read(path):
        relative = path.relative_to(root).as_posix()
        if relative not in cached:
            cached[relative] = json.loads(capture(path))
            reject_secrets(cached[relative])
        return cached[relative]

    records = [read(path) for path in sorted((root / 'records').glob('*.json'))]
    candidate_ids = {row['candidate_id'] for row in records}
    source_files = sorted(p for p in root.rglob('*') if p.is_file())
    for path in source_files:
        relative = path.relative_to(root)
        if not selected(relative, candidate_ids):
            continue
        data = capture(path)
        if path.suffix == '.json':
            read(path)
        elif path.suffix == '.md':
            reject_secrets(data.decode('utf-8'))
        destination = staging / 'artifacts' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        manifest.append({'path': destination.relative_to(staging).as_posix(), 'source_path': str(path),
                         'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})

    responses, pending, response_ids = [], [], {}
    for path in source_files:
        if 'batches' not in path.relative_to(root).parts or path.name != 'response.json':
            continue
        raw = read(path)
        state_path = path.with_name('call-state.json')
        state = read(state_path) if state_path.exists() else {}
        item = {'source_path': str(path), 'response_sha256': hashlib.sha256(capture(path)).hexdigest(),
                'response_id': raw.get('id'), 'model': raw.get('model'), 'status': raw.get('status'),
                'role': state.get('role'), 'usage': raw.get('usage'), 'categories': usage_summary(raw),
                'cost_usd': audit.price(raw), 'origin': 'Mac' if 'mac-checkpoint' in path.relative_to(root).parts else 'Shadow'}
        responses.append(item)
        if raw.get('id'):
            existing = response_ids.get(raw['id'])
            if existing and existing['response_sha256'] != item['response_sha256']:
                raise ValueError('Same response ID has conflicting raw bytes')
            response_ids[raw['id']] = item
    captured_response_paths = {r['source_path'] for r in responses}
    for path in source_files:
        if path.name == 'call-state.json' and 'batches' in path.relative_to(root).parts:
            # Use the captured response inventory; never imply a live request is failed.
            if str(path.with_name('response.json')) not in captured_response_paths:
                pending.append({'source_path': str(path), 'state': read(path), 'charge_status': 'unknown',
                                'reason': 'Call state exists without a captured durable response; may still be in flight. Never automatically retry.'})

    media, receipts, transfers = [], {}, []
    for relative, data in list(cached.items()):
        path = root / relative
        if path.name == 'result.json' and data.get('output_sha256') and data.get('clip_path'):
            local_media = path.parent / 'clip.mp4'
            size = local_media.stat().st_size if local_media.exists() else None
            media.append({'candidate_id': data.get('candidate_id'), 'source_path': data['clip_path'],
                          'local_path': str(local_media), 'sha256': data['output_sha256'],
                          'size': data.get('output_bytes'), 'observed_size': size,
                          'local_present': size is not None,
                          'size_matches_receipt': size == data.get('output_bytes') if size is not None else None,
                          'hash_basis': 'Existing hash-bound render result; media not rehashed or copied by checkpoint',
                          'receipt': 'artifacts/' + relative})
        if path.parent.name == 'publications' and data.get('snippet_id'):
            receipts[data['snippet_id']] = data
        if path.name == 'transfer.json':
            transfers.append({'source_path': str(path),
                              'body_bytes_read': data.get('upstream_body_bytes_read', 0),
                              'requested_bytes': data.get('upstream_requested_bytes', 0),
                              'origin': 'Mac' if 'mac-checkpoint' in path.relative_to(root).parts else 'Shadow'})
    for receipt in receipts.values():
        media.append({'candidate_id': receipt.get('video_id'), 'gcs_url': receipt.get('gcs_url'),
                      'gcs_generation': receipt.get('gcs_generation'), 'sha256': receipt.get('media_sha256'),
                      'size': receipt.get('uploaded_bytes'), 'hash_basis': 'Publication receipt', 'published': True})
    inventoried = {row['local_path'] for row in media if row.get('local_path')}
    for path in source_files:
        if path.suffix.lower() in MEDIA_SUFFIXES and str(path) not in inventoried:
            media.append({'local_path': str(path), 'observed_size': path.stat().st_size,
                          'sha256': None, 'size': None, 'local_present': True,
                          'hash_basis': 'No captured completed render receipt; may be in progress. Not safe to transfer as final media.'})

    mapping_path = root / 'checkpoint-paths.json'
    mappings = [{'source_prefix': str(root), 'snapshot_relative_prefix': 'artifacts'}]
    if mapping_path.exists():
        for old, new in read(mapping_path).items():
            mapped = Path(new).resolve()
            if mapped.is_relative_to(root):
                mappings.append({'source_prefix': old, 'snapshot_relative_prefix': 'artifacts/' + mapped.relative_to(root).as_posix()})
    baseline_path = root / 'checkpoint-status.json'
    baseline = read(baseline_path) if baseline_path.exists() else {}
    current = [r for r in response_ids.values() if r['origin'] == 'Shadow']
    counts = dict(Counter(row['status'] for row in records))
    summary = {'schema_version': 'snippy-compact-checkpoint-v1', 'started_at': started, 'finished_at': audit.now(),
               'source_root': str(root), 'snapshot_consistency': 'Live nontransactional snapshot; each copied artifact read stably. Records captured first.',
               'counts': counts, 'recorded_candidates': len(records), 'copied_files': len(manifest),
               'copied_bytes': sum(row['size'] for row in manifest), 'media_bytes_copied': 0,
               'unknown_charge_calls': len(pending), 'current_response_count': len(current),
               'checkpoint_cost_usd': baseline.get('luna_cost_usd', 0),
               'current_cost_usd': sum(row['cost_usd'] for row in current),
               'known_total_cost_usd': baseline.get('luna_cost_usd', 0) + sum(row['cost_usd'] for row in current),
               'cost_limitation': 'Known response usage only; unknown-charge calls excluded. GCS transfer bytes are not billing measurements.',
               'bigquery_bytes_billed': sum(row.get('query_bytes_billed', 0) for row in receipts.values()),
               'transfer_body_bytes_read': sum(row['body_bytes_read'] for row in transfers),
               'transfer_requested_bytes': sum(row['requested_bytes'] for row in transfers),
               'excluded': ['All video/audio bytes', 'Raw request.json and packages.json with embedded base64',
                            'Raw response.json (usage summaries retained)', 'Logs, private environment files and credentials',
                            'Unchanged full corpus and cull transcripts; retain the verified original input bundle'],
               'complete_checkpoint': True}
    reports = {'summary.json': summary, 'manifest.json': {'files': manifest},
               'locator-map.json': {'prefix_mappings': mappings, 'original_paths_preserved': True},
               'media-inventory.json': {'items': media, 'bytes_copied': 0},
               'response-usage.json': {'responses': responses, 'unknown_charge_calls': pending},
               'transfer-summary.json': {'items': transfers}}
    for filename, value in reports.items():
        (staging / filename).write_bytes(json_bytes(value))
    staging.rename(final)
    return {'directory': str(final), **summary}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(create_checkpoint(args.root, args.output), indent=2))


if __name__ == '__main__':
    main()
