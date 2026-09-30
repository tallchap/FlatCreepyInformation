#!/usr/bin/env python3
"""Read-only verification of the Mac checkpoint before Shadow resumes.

The report never authorizes replay: every checkpoint ID stays excluded even if
its receipt is held. Network checks run sequentially; no media/model writes.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from urllib.parse import quote

import audit
import luna_batch_qa as luna

TABLE = 'youtubetranscripts-429803.reptranscripts.snippets_auto'
BUCKET = 'snippysaurus-clips'
PUBLISHED = {'published', 'already_published'}
ROW_FIELDS = {'snippet_id', 'original_video_id', 'title', 'description', 'category',
              'duration_ms', 'transcript', 'gcs_url', 'provider', 'speaker', 'created_at'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def file_hash(path, algorithm='sha256'):
    value = hashlib.new(algorithm)
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def local_path(checkpoint, original):
    """Resolve an original Mac pointer without rewriting hash-bound artifacts."""
    parts = PurePosixPath(str(original).replace('\\', '/')).parts
    require('..' not in parts, 'Unsafe checkpoint artifact path')
    markers = [i for i, part in enumerate(parts) if part in ('production-1644', 'mac-checkpoint')]
    if markers:
        candidate = checkpoint.joinpath(*parts[markers[-1] + 1:]).resolve()
    else:
        candidate = Path(original).resolve()
    require(candidate.is_relative_to(checkpoint.resolve()), 'Artifact is outside supplied checkpoint')
    return candidate


def validate_receipt(vid, receipt):
    require(receipt.get('passed') is True and receipt.get('video_id') == vid, 'Receipt candidate/status mismatch')
    for field in ('media_sha256', 'recipe_hash'):
        require(re.fullmatch('[0-9a-f]{64}', str(receipt.get(field, ''))) is not None, f'Invalid {field}')
    rh = receipt['recipe_hash']
    sid = f'astra_{vid}_{rh[:12]}'
    name = f'clips/astra/{vid}/{rh[:16]}.mp4'
    require(receipt.get('snippet_id') == sid, 'Snippet identity is not recipe-bound')
    require(receipt.get('gcs_url') == f'https://storage.googleapis.com/{BUCKET}/{name}', 'Unexpected publication URL')
    require(re.fullmatch('[0-9]+', str(receipt.get('gcs_generation', ''))) is not None, 'Missing GCS generation')
    require(type(receipt.get('uploaded_bytes')) is int and receipt['uploaded_bytes'] >= 32, 'Invalid uploaded size')
    row = receipt.get('row', {})
    require(ROW_FIELDS.issubset(row), 'Receipt lacks complete database identity')
    require(row['snippet_id'] == sid and row['original_video_id'] == vid and row['provider'] == 'astra'
            and row['gcs_url'] == receipt['gcs_url'], 'Receipt row identity mismatch')
    return name


def verify_db(receipt, rows):
    vid, sid = receipt['video_id'], receipt['snippet_id']
    source_rows = [row for row in rows if row.get('original_video_id') == vid and row.get('provider') == 'astra']
    matches = [row for row in rows if row.get('snippet_id') == sid]
    require(len(source_rows) == 1, f'Expected one Astra publication for source; found {len(source_rows)}')
    require(len(matches) == 1, f'Expected one snippet row; found {len(matches)}')
    expected = receipt['row']
    drift = [key for key, value in expected.items() if key not in matches[0] or str(matches[0][key]) != str(value)]
    require(not drift, 'Database row drift: ' + ', '.join(drift))


def verify_metadata(receipt, metadata, name):
    require(metadata.get('bucket') == BUCKET and metadata.get('name') == name, 'GCS object identity drift')
    require(str(metadata.get('generation')) == str(receipt['gcs_generation']), 'GCS generation drift')
    require(int(metadata.get('size', -1)) == receipt['uploaded_bytes'], 'GCS size drift')


def verify_site(receipt, rows):
    require(isinstance(rows, list), 'Site API did not return a snippet list')
    matches = [row for row in rows if row.get('snippetId') == receipt['snippet_id']]
    require(len(matches) == 1, f'Site API has {len(matches)} matching snippets')
    require(matches[0].get('gcsUrl') == receipt['gcs_url'], 'Site media URL drift')


def verify_local(checkpoint, record, receipt, metadata):
    if not record.get('final_directory'):
        require(record['status'] == 'already_published', 'Published record lacks local final directory')
        return {'status': 'not_transferred', 'limitation': 'Original publication receipt plus live GCS generation/size and DB identity; no new full-object SHA check.'}
    directory = local_path(checkpoint, record['final_directory'])
    media = directory / 'clip.mp4'
    recipe, qa = read(directory / 'recipe.json'), read(directory / 'final-qa.json')
    require(receipt['media_sha256'] == qa.get('media_sha256'), 'Receipt media SHA/QA drift')
    require(audit.digest(recipe) == receipt['recipe_hash'] == qa.get('recipe_hash'), 'Local recipe/QA drift')
    require(recipe.get('candidate_id') == receipt['video_id'], 'Local recipe candidate drift')
    require(qa.get('passed') is True and all(qa.get('checks', {}).get(key) is True for key in
            ('picture_verified', 'dialogue_verified', 'boundaries_verified', 'duration_verified', 'metadata_verified')), 'Local QA checks incomplete')
    require(str(qa.get('reviewer', '')).startswith('gpt-6-luna') and luna.release_gate_passed(qa.get('release_gate'), .95), 'Local Luna release gate drift')
    if not media.exists():
        return {'status': 'evidence_verified_media_not_transferred', 'directory': str(directory),
                'media_sha256': receipt['media_sha256'], 'recipe_hash': receipt['recipe_hash'],
                'limitation': 'Recipe and QA hashes verified locally; media verified through immutable live generation/size, no new full-object SHA check.'}
    require(file_hash(media) == receipt['media_sha256'], 'Local media SHA drift')
    md5 = base64.b64encode(bytes.fromhex(file_hash(media, 'md5'))).decode('ascii')
    require(metadata.get('md5Hash') == md5, 'Local media differs from GCS MD5')
    require(media.stat().st_size == receipt['uploaded_bytes'], 'Local media size drift')
    return {'status': 'verified', 'directory': str(directory), 'media_sha256': receipt['media_sha256'], 'recipe_hash': receipt['recipe_hash'], 'md5': md5}


class LiveReader:
    def __init__(self):
        import google.auth
        from google.auth.transport.requests import AuthorizedSession
        import requests
        self.auth = AuthorizedSession(google.auth.default(scopes=['https://www.googleapis.com/auth/devstorage.read_only'])[0])
        self.public = requests.Session()

    def database(self, receipts):
        from google.cloud import bigquery
        vids = [receipt['video_id'] for receipt in receipts]
        ids = [receipt['snippet_id'] for receipt in receipts]
        config = bigquery.QueryJobConfig(query_parameters=[bigquery.ArrayQueryParameter('vids', 'STRING', vids),
                                                           bigquery.ArrayQueryParameter('ids', 'STRING', ids)])
        job = audit.bq_client().query(f'SELECT * FROM `{TABLE}` WHERE original_video_id IN UNNEST(@vids) OR snippet_id IN UNNEST(@ids)', job_config=config)
        rows = [dict(row) for row in job.result()]
        return rows, {'job_id': job.job_id, 'bytes_billed': job.total_bytes_billed or 0,
                      'bytes_processed': job.total_bytes_processed or 0, 'cache_hit': job.cache_hit}

    def metadata(self, name):
        with self.auth.get(f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/{quote(name, safe="")}', timeout=(15, 45)) as response:
            response.raise_for_status()
            return response.json()

    def playback(self, receipt, expected_prefix=None):
        with self.public.get(receipt['gcs_url'], headers={'Range': 'bytes=0-31', 'Accept-Encoding': 'identity'},
                             timeout=(15, 45), stream=True) as response:
            response.raise_for_status()
            require(response.status_code == 206, 'GCS ignored bounded playback range')
            require(response.headers.get('Content-Range') == f"bytes 0-31/{receipt['uploaded_bytes']}", 'Playback Content-Range drift')
            require(response.headers.get('Content-Length') == '32', 'Playback response length drift')
            require(response.headers.get('x-goog-generation') == str(receipt['gcs_generation']), 'Playback generation drift')
            prefix = response.raw.read(33, decode_content=False)
            require(len(prefix) == 32, 'Playback did not return exactly 32 bytes')
            require(expected_prefix is None or prefix == expected_prefix, 'Playback bytes differ from local artifact')
            return {'bytes_read': len(prefix), 'generation': response.headers['x-goog-generation']}

    def site(self, vid):
        with self.public.get('https://www.snippysaurus.com/api/snippets/auto', params={'videoId': vid}, timeout=(15, 45)) as response:
            response.raise_for_status()
            return response.json()

    def close(self):
        self.auth.close()
        self.public.close()


def verify(checkpoint, manifest, output, reader, expected_records=20, expected_publications=19):
    checkpoint = Path(checkpoint).resolve()
    records = [read(path) for path in sorted((checkpoint / 'records').glob('*.json'))]
    wanted = {row['candidate_id'] for row in read(manifest)['candidates']}
    ids = [row.get('candidate_id') for row in records]
    checks = {'checkpoint_inventory': len(ids) == len(set(ids)) == expected_records and set(ids).issubset(wanted),
              'checkpoint_terminal': all(row.get('status') in PUBLISHED | {'awaiting_astra'} for row in records)}
    publications, results = [], []
    for record in records:
        if record.get('status') not in PUBLISHED:
            continue
        vid = record['candidate_id']
        item = {'candidate_id': vid, 'original_status': record['status'], 'status': 'held', 'checks': {}, 'errors': []}
        try:
            receipt = read(checkpoint / 'publications' / f'{vid}.json')
            name = validate_receipt(vid, receipt)
            item['checks']['receipt_identity'] = True
            item['receipt_sha256'] = file_hash(checkpoint / 'publications' / f'{vid}.json')
            publications.append((record, receipt, name, item))
        except Exception as exc:
            item['checks']['receipt_identity'] = False
            item['errors'].append(f'{type(exc).__name__}: {exc}')
        results.append(item)
    checks['publication_inventory'] = len(results) == len(publications) == expected_publications
    db_receipt, db_error, rows = None, None, []
    try:
        rows, db_receipt = reader.database([entry[1] for entry in publications])
    except Exception as exc:
        db_error = f'{type(exc).__name__}: {exc}'
    for record, receipt, name, item in publications:
        def check(label, operation):
            try:
                value = operation()
                item['checks'][label] = True
                return value
            except Exception as exc:
                item['checks'][label] = False
                item['errors'].append(f'{label}: {type(exc).__name__}: {exc}')
                return None
        def database_check():
            require(db_error is None, db_error or '')
            verify_db(receipt, rows)
        check('live_database_identity_and_uniqueness', database_check)
        metadata = check('live_gcs_metadata', lambda: reader.metadata(name))
        if metadata is not None:
            check('live_gcs_identity_generation_size', lambda: verify_metadata(receipt, metadata, name))
            item['local_artifact'] = check('local_artifact_if_transferred', lambda: verify_local(checkpoint, record, receipt, metadata))
        else:
            item['checks']['live_gcs_identity_generation_size'] = False
            item['checks']['local_artifact_if_transferred'] = False
        prefix = None
        if (item.get('local_artifact') or {}).get('status') == 'verified':
            with (Path(item['local_artifact']['directory']) / 'clip.mp4').open('rb') as handle:
                prefix = handle.read(32)
        item['playback'] = check('live_public_playback', lambda: reader.playback(receipt, prefix))
        check('live_site_api', lambda: verify_site(receipt, reader.site(receipt['video_id'])))
        item['status'] = 'verified' if all(item['checks'].values()) else 'held'
    checks['all_prior_publications_verified'] = all(row['status'] == 'verified' for row in results) and len(results) == expected_publications
    report = {'schema_version': 'snippy-mac-checkpoint-verification-v1', 'time': audit.now(),
              'checkpoint': str(checkpoint), 'requested': f'{expected_records} preserved checkpoint records, {expected_publications} published receipts',
              'conducted': {'records': len(records), 'publication_receipts': len(results)}, 'passed': all(checks.values()),
              'checks': checks, 'preserve_skip_ids': sorted(ids), 'replay_authorized': False,
              'held_ids': [row['candidate_id'] for row in results if row['status'] == 'held'],
              'awaiting_astra_ids': [row['candidate_id'] for row in records if row.get('status') == 'awaiting_astra'],
              'query_receipt': db_receipt, 'query_error': db_error, 'results': results,
              'network_concurrency': 1, 'limitations': ['Prior artifacts not included in the transfer are verified by original receipt, current immutable GCS generation/size and exact database identity; no new full-object SHA is claimed.']}
    audit.atomic(Path(output), report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    reader = LiveReader()
    try:
        result = verify(args.checkpoint, args.manifest, args.output, reader)
    finally:
        reader.close()
    print(json.dumps({'passed': result['passed'], 'checks': result['checks'], 'held_ids': result['held_ids'], 'report': str(args.output.resolve())}, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
