#!/usr/bin/env python3
"""Offline production accounting and coverage. --verify hashes final media once.

The default snapshot reads JSON receipts and file sizes only. Missing candidates
remain pending. Costs use audit.price unchanged and are estimates from API usage,
not billing statements. No network, publishing, transcription, or model calls.
"""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import json
import math
from pathlib import Path
import re

import audit

PUBLISHED = {'published', 'already_published'}
FAILED = {'failed', 'source_failed', 'other_failed'}
DISPOSED = PUBLISHED | FAILED | {'awaiting_astra'}
SOURCE_ERROR = re.compile(r'\b(?:403|404|410|412)\b|generation.{0,30}(?:changed|mismatch)|(?:source|object).{0,30}(?:missing|not found|unavailable)|transfer budget exhausted', re.I)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def flattened_numbers(value, prefix=''):
    result = {}
    for key, item in value.items():
        key = prefix + key
        if isinstance(item, dict):
            result.update(flattened_numbers(item, key + '.'))
        elif numeric(item):
            result[key] = item
    return result


class Reporter:
    def __init__(self, root, verify_media=False, expected_count=1644, checkpoint_counts=(19, 1)):
        self.root = Path(root).resolve()
        self.verify_media, self.expected_count = verify_media, expected_count
        self.checkpoint_counts = checkpoint_counts
        self.errors, self.jobs, self.job_unknown = [], {}, []
        self.hashed, self.transfers, self.receipts = {}, {}, {}
        self.mappings = self.read(self.root / 'checkpoint-paths.json', optional=True) or {}

    def error(self, code, path=None, **detail):
        self.errors.append({'code': code, **({'path': str(path)} if path else {}), **detail})

    def read(self, path, optional=False):
        path = Path(path)
        if optional and not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError) as exc:
            self.error('missing_or_invalid_json', path, error_type=type(exc).__name__)
            return None

    def resolve(self, value):
        normalized = str(value).replace('\\', '/')
        for old, new in sorted(self.mappings.items(), key=lambda x: len(x[0]), reverse=True):
            old = old.replace('\\', '/').rstrip('/')
            if normalized == old or normalized.startswith(old + '/'):
                return Path(new) / normalized[len(old):].lstrip('/')
        path = Path(value)
        return path if path.is_absolute() else self.root / path

    def hash(self, path):
        path = Path(path)
        if path not in self.hashed:
            self.hashed[path] = sha(path)
        return self.hashed[path]

    def bq_jobs(self, value, path):
        if isinstance(value, dict):
            if value.get('job_id') and ('bytes_billed' in value or 'bytes_processed' in value or 'cache_hit' in value):
                job_id = value['job_id']
                record = {k: value.get(k) for k in ('job_id', 'bytes_billed', 'bytes_processed', 'cache_hit')}
                old = self.jobs.get(job_id)
                if old and any(old.get(k) is not None and record.get(k) is not None and old[k] != record[k] for k in record):
                    self.error('conflicting_bigquery_job_receipts', path, job_id=job_id)
                if not old:
                    self.jobs[job_id] = {**record, 'receipt_paths': [str(path)]}
                else:
                    for key, item in record.items():
                        if old.get(key) is None:
                            old[key] = item
                    if str(path) not in old['receipt_paths']:
                        old['receipt_paths'].append(str(path))
            if value.get('query_job'):
                self.bq_jobs({'job_id': value['query_job'], 'bytes_processed': value.get('bytes_processed'),
                              'bytes_billed': value.get('bytes_billed')}, path)
            for item in value.values():
                self.bq_jobs(item, path)
        elif isinstance(value, list):
            for item in value:
                self.bq_jobs(item, path)

    def transfer(self, data, path):
        if not isinstance(data, dict) or 'upstream_body_bytes_read' not in data:
            return
        key = audit.digest(data)
        fields = ['upstream_body_bytes_read', 'upstream_requested_bytes', 'conservative_response_bytes_upper_bound']
        if not all(numeric(data.get(k)) for k in fields):
            self.error('invalid_transfer_receipt', path)
        elif not data[fields[0]] <= data[fields[2]] <= data[fields[1]]:
            self.error('inconsistent_transfer_bounds', path)
        if key not in self.transfers:
            self.transfers[key] = {'receipt_sha256': key, **{k: data.get(k) for k in fields},
                                   'source_generation': data.get('source_generation'),
                                   'errors': data.get('errors', []), 'receipt_paths': []}
        if str(path) not in self.transfers[key]['receipt_paths']:
            self.transfers[key]['receipt_paths'].append(str(path))

    def api_accounting(self):
        responses, requests, unknown, totals = {}, {}, [], Counter()
        for base in (self.root / 'batches', self.root / 'mac-checkpoint/batches'):
            for path in sorted(base.glob('*/*/request.json')):
                body = self.read(path)
                if not isinstance(body, dict):
                    continue
                request_hash = audit.digest(body)
                if path.parent.name != request_hash:
                    self.error('request_hash_drift', path, expected_directory=request_hash)
                response_path, state_path = path.with_name('response.json'), path.with_name('call-state.json')
                state = self.read(state_path, optional=True) or {}
                requests.setdefault(request_hash, {'request_hash': request_hash, 'model': body.get('model'),
                    'request_paths': [], 'response_ids': [], 'call_states': []})
                item = requests[request_hash]
                item['request_paths'].append(str(path))
                item['call_states'].append({'path': str(state_path), **{k: state[k] for k in ('status', 'attempt', 'http_status', 'role') if k in state}})
                if not response_path.exists():
                    status = state.get('status')
                    # Saved requests alone do not prove that an API request was sent.
                    unknown.append({'request_hash': request_hash, 'request_path': str(path),
                        'status': status or 'no_durable_call_state',
                        'charge_unknown': status not in ('rejected', 'rate_limited') and not
                            (status == 'cancelled_before_dispatch' and state.get('dispatched') is False
                             and state.get('charge_unknown') is False)})
                    continue
                raw = self.read(response_path)
                if not isinstance(raw, dict) or not raw.get('id'):
                    self.error('response_id_missing', response_path)
                    continue
                rid, usage = raw['id'], raw.get('usage')
                item['response_ids'].append(rid)
                if rid in responses:
                    if responses[rid]['response_sha256'] != audit.digest(raw):
                        self.error('conflicting_response_id', response_path, response_id=rid)
                    responses[rid]['response_paths'].append(str(response_path))
                    if base.parent.name == 'mac-checkpoint':
                        responses[rid]['origin'] = 'Mac'
                    continue
                valid_usage = isinstance(usage, dict) and all(numeric(usage.get(k)) for k in ('input_tokens', 'output_tokens'))
                if valid_usage:
                    detail = usage.get('input_tokens_details') or {}
                    valid_usage = isinstance(detail, dict) and all(numeric(detail.get(k, 0)) for k in ('cached_tokens', 'cache_write_tokens'))
                    if valid_usage:
                        valid_usage = detail.get('cached_tokens', 0) + detail.get('cache_write_tokens', 0) <= usage['input_tokens']
                luna = str(raw.get('model', '')).startswith('gpt-6-luna')
                if not luna:
                    self.error('unexpected_api_model', response_path, model=raw.get('model'))
                if body.get('model') != raw.get('model'):
                    self.error('request_response_model_mismatch', response_path)
                cost = audit.price(raw) if valid_usage and luna else None
                if not valid_usage:
                    self.error('missing_api_usage_receipt', response_path, response_id=rid)
                row = {'response_id': rid, 'request_hash': request_hash, 'model': raw.get('model'),
                    'provider_request_id': raw.get('_request_id') or raw.get('request_id'),
                    'response_status': raw.get('status'), 'usage': usage,
                    'usage_derived_cost_usd': cost, 'response_sha256': audit.digest(raw),
                    'response_paths': [str(response_path)], 'origin': 'Mac' if base.parent.name == 'mac-checkpoint' else 'Shadow'}
                responses[rid] = row
                if valid_usage:
                    totals.update(flattened_numbers(usage))
        for base in (self.root / 'batches', self.root / 'mac-checkpoint/batches'):
            for path in base.glob('*/*/response.json'):
                if not path.with_name('request.json').exists():
                    self.error('response_missing_request_receipt', path)
        cost = sum(r['usage_derived_cost_usd'] or 0 for r in responses.values())
        mac_cost = sum(r['usage_derived_cost_usd'] or 0 for r in responses.values() if r['origin'] == 'Mac')
        saved = self.read(self.root / 'checkpoint-status.json', optional=True) or {}
        if saved and (len([r for r in responses.values() if r['origin'] == 'Mac']) != saved.get('unique_api_responses') or abs(mac_cost - saved.get('luna_cost_usd', 0)) > 1e-10):
            self.error('checkpoint_api_accounting_mismatch', self.root / 'checkpoint-status.json')
        return {'unique_requests': len(requests), 'unique_responses': len(responses), 'token_categories': dict(totals),
            'luna_cost_usd': cost, 'checkpoint_usage_derived_cost_usd': mac_cost,
            'shadow_usage_derived_cost_usd': cost - mac_cost,
            'unknown_charge_requests': [r for r in unknown if r['charge_unknown']],
            'requests_without_response': unknown, 'unpriced_response_ids': [k for k, v in responses.items() if v['usage_derived_cost_usd'] is None],
            'pricing_basis': 'Unchanged audit.price(raw_response); usage-derived estimate, not billed charges. Unknown charges excluded, never assumed zero.',
            'requests': list(requests.values()), 'responses': list(responses.values())}

    def failure_kind(self, row):
        if row.get('status') not in FAILED:
            return None
        if row.get('status') == 'source_failed' or row.get('failure_kind') == 'source_failed':
            return 'source_failed'
        if row.get('isolated_source_failure'):
            return 'source_failed'
        details = [str(row.get('error', '')), str(row.get('failure_category', ''))]
        directories = [self.resolve(row['directory'])] if row.get('directory') else list((self.root / 'rendered').glob(str(row.get('candidate_id', '')) + '-*'))
        for directory in directories:
            transfer = self.read(directory / 'transfer.json', optional=True) or {}
            details.append(json.dumps(transfer.get('errors', [])))
            statuses = [page.get('status') for request in transfer.get('requests', []) for page in request.get('pages', [])]
            if any(status in (403, 404, 410, 412) for status in statuses):
                return 'source_failed'
        if row.get('stage') in ('preparation', 'source', 'render') and SOURCE_ERROR.search(' '.join(details)):
            return 'source_failed'
        return 'other_failed'

    def verify_directory(self, directory, published=False):
        from luna_batch_qa import release_gate_passed, words_from
        try:
            result, recipe, asr, binding = (self.read(directory / name) for name in
                ('result.json', 'recipe.json', 'asr/clip.json', 'asr/evidence.json'))
            media_hash = self.hash(directory / 'clip.mp4')
            if media_hash != result['output_sha256'] or media_hash != binding['media_sha256'] or self.hash(directory / 'asr/clip.json') != binding['asr_sha256']:
                self.error('media_or_asr_binding_hash_drift', directory)
            if not words_from(asr):
                self.error('empty_asr_words', directory)
            if published:
                qa = self.read(directory / 'final-qa.json')
                if qa.get('passed') is not True or qa['media_sha256'] != media_hash or qa['recipe_hash'] != audit.digest(recipe):
                    self.error('publication_qa_hash_drift', directory)
                if not all(qa.get('checks', {}).get(k) is True for k in ('picture_verified', 'dialogue_verified', 'boundaries_verified', 'duration_verified')):
                    self.error('publication_qa_checks_missing', directory)
                if str(qa.get('reviewer', '')).startswith('gpt-6-luna') and not release_gate_passed(qa.get('release_gate'), .95):
                    self.error('publication_release_gate_failed', directory)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            self.error('media_verification_failed', directory, error_type=type(exc).__name__)

    def coverage(self, candidates):
        grouped = defaultdict(list)
        for path in sorted((self.root / 'records').glob('*.json')):
            row = self.read(path)
            if isinstance(row, dict) and row.get('candidate_id'):
                grouped[row['candidate_id']].append((path, row))
        wanted = {r['candidate_id'] for r in candidates}
        for vid, rows in grouped.items():
            if len(rows) != 1 or vid not in wanted or any(path.stem != vid for path, _ in rows):
                self.error('duplicate_unexpected_or_misnamed_record', candidate_id=vid, paths=[str(p) for p, _ in rows])
        coverage = []
        for item in candidates:
            vid = item['candidate_id']
            path, row = grouped[vid][0] if grouped[vid] else (self.root / 'records' / (vid + '.json'), {})
            status = row.get('status', 'pending')
            refs = {k: str(self.resolve(row[k])) for k in ('publication_receipt', 'directory', 'final_directory', 'handoff', 'packet_path', 'batch') if row.get(k)}
            current = {'candidate_id': vid, 'lane': item.get('lane'), 'status': status,
                'stage': row.get('stage'), 'failure_category': row.get('failure_category'),
                'disposition': self.failure_kind(row) or status,
                'disposed': status in DISPOSED, 'complete': status in PUBLISHED,
                'checkpoint_origin': row.get('checkpoint_origin'), 'evidence': refs,
                'record_path': str(path), 'record_sha256': self.hash(path) if row else None,
                'reason': row.get('reason') or row.get('error')}
            coverage.append(current)
            self.transfer(row.get('transfer'), path)
            if self.verify_media:
                packet_path = self.root / 'input/candidates' / f'{vid}.json'
                packet = self.read(packet_path)
                if packet is not None and audit.digest(packet) != item.get('packet_sha256'):
                    self.error('candidate_packet_hash_drift', packet_path)
            if status in PUBLISHED:
                receipt_path = self.resolve(row.get('publication_receipt', '__missing_publication_receipt__'))
                receipt = self.read(receipt_path)
                if not isinstance(receipt, dict) or receipt.get('passed') is not True or receipt.get('video_id') != vid:
                    self.error('publication_receipt_failed', receipt_path, candidate_id=vid)
                else:
                    key = receipt.get('snippet_id')
                    if not key or not receipt.get('media_sha256') or not receipt.get('recipe_hash'):
                        self.error('publication_receipt_identity_missing', receipt_path)
                    if key in self.receipts and audit.digest(receipt) != audit.digest(self.receipts[key]):
                        self.error('conflicting_publication_receipts', receipt_path)
                    self.receipts[key] = receipt
                    self.bq_jobs(receipt, receipt_path)
                    if self.verify_media and status == 'published':
                        directory = self.resolve(row.get('final_directory', '__missing_final_directory__'))
                        self.verify_directory(directory, published=True)
                        if (directory / 'clip.mp4').exists() and (self.hash(directory / 'clip.mp4') != receipt['media_sha256'] or audit.digest(self.read(directory / 'recipe.json')) != receipt['recipe_hash']):
                            self.error('publication_media_receipt_hash_drift', receipt_path)
            elif status == 'awaiting_astra':
                if row.get('handoff') and not self.resolve(row['handoff']).exists():
                    self.error('astra_handoff_missing', row['handoff'], candidate_id=vid)
                if not row.get('handoff') and not (row.get('stage') == 'proposal' and row.get('reason') and row.get('packet_path')):
                    self.error('astra_handoff_or_proposal_evidence_missing', path, candidate_id=vid)
                if self.verify_media and row.get('directory') and row.get('checkpoint_origin') != 'Mac':
                    self.verify_directory(self.resolve(row['directory']))
        return coverage, grouped

    def checkpoint(self, grouped):
        originals = {}
        for path in sorted((self.root / 'mac-checkpoint/records').glob('*.json')):
            row = self.read(path)
            if isinstance(row, dict):
                originals[row['candidate_id']] = (path, row)
        pubs = [vid for vid, (_, row) in originals.items() if row.get('status') in PUBLISHED]
        holds = [vid for vid, (_, row) in originals.items() if row.get('status') == 'awaiting_astra']
        if (len(pubs), len(holds)) != self.checkpoint_counts or len(originals) != sum(self.checkpoint_counts):
            self.error('mac_checkpoint_inventory_drift', published=len(pubs), awaiting_astra=len(holds))
        prior = self.read(self.root / 'prior-verification.json', optional=not originals) or {}
        if originals and (prior.get('passed') is not True or set(prior.get('preserve_skip_ids', [])) != set(originals)):
            self.error('mac_checkpoint_prior_verification_failed', self.root / 'prior-verification.json')
        prior_results = {r['candidate_id']: r for r in prior.get('results', [])}
        for vid, (path, original) in originals.items():
            values = grouped.get(vid, [])
            row = values[0][1] if len(values) == 1 else {}
            expected = 'already_published' if vid in pubs else 'awaiting_astra'
            if row.get('status') != expected or row.get('checkpoint_origin') != 'Mac' or row.get('checkpoint_record_sha256') != self.hash(path):
                self.error('mac_checkpoint_record_not_preserved', path, candidate_id=vid)
            if vid in pubs:
                receipt = self.resolve(row.get('publication_receipt', '__missing__'))
                try:
                    digest = self.hash(receipt)
                    if digest != row.get('checkpoint_receipt_sha256') or digest != prior_results.get(vid, {}).get('receipt_sha256'):
                        self.error('mac_checkpoint_receipt_hash_drift', receipt, candidate_id=vid)
                except OSError:
                    self.error('mac_checkpoint_receipt_missing', receipt, candidate_id=vid)
        self.bq_jobs(prior, self.root / 'prior-verification.json')
        return {'published_ids': pubs, 'awaiting_astra_ids': holds,
            'expected_published': self.checkpoint_counts[0], 'expected_awaiting_astra': self.checkpoint_counts[1],
            'preserved': not any(e['code'].startswith('mac_checkpoint') for e in self.errors),
            'prior_verification_path': str(self.root / 'prior-verification.json'),
            'media_scope': 'Mac media not transferred; original readback proof retained, not claimed locally rehashed.'}

    def run(self):
        manifest = self.read(self.root / 'input/manifest.json') or {}
        candidates = manifest.get('candidates', [])
        ids = [r.get('candidate_id') for r in candidates]
        if len(ids) != self.expected_count or len(set(ids)) != len(ids) or any(not isinstance(vid, str) for vid in ids):
            self.error('manifest_exact_inventory_failed', actual=len(ids), expected=self.expected_count)
        # Keep one CSV row per ID even when a corrupt manifest repeats it.
        unique = {r['candidate_id']: r for r in candidates if isinstance(r.get('candidate_id'), str)}
        coverage, grouped = self.coverage(list(unique.values()))
        checkpoint = self.checkpoint(grouped)
        api = self.api_accounting()
        for base in (self.root / 'rendered', self.root / 'mac-checkpoint/rendered'):
            for path in sorted(base.glob('*/transfer.json')):
                self.transfer(self.read(path), path)
        for path in sorted(self.root.glob('*.json')):
            if path.name not in ('production-report.json', 'astra-handoff-queue.json'):
                data = self.read(path)
                if data is not None:
                    self.bq_jobs(data, path)
        for base in (self.root / 'publications', self.root / 'mac-checkpoint/publications',
                     self.root / 'publication-attempts', self.root / 'mac-checkpoint/publication-attempts'):
            for path in base.glob('*.json'):
                receipt = self.read(path)
                if receipt is not None:
                    self.bq_jobs(receipt, path)
        counts = Counter(row['status'] for row in coverage)
        dispositions = Counter(row['disposition'] for row in coverage)
        pending = [r['candidate_id'] for r in coverage if not r['disposed']]
        transfer_totals = {key: sum(t[key] for t in self.transfers.values() if numeric(t.get(key))) for key in
            ('upstream_body_bytes_read', 'upstream_requested_bytes', 'conservative_response_bytes_upper_bound')}
        media_paths = [p for base in (self.root / 'rendered', self.root / 'batches') for p in base.rglob('clip.mp4')]
        checks = {'integrity': not self.errors, 'exact_coverage': len(coverage) == self.expected_count,
            'all_disposed': not pending, 'no_operational_failures': not any(r['status'] in FAILED for r in coverage),
            'no_unknown_charge_requests': not api['unknown_charge_requests'],
            'all_responses_priced_from_usage': not api['unpriced_response_ids'],
            'mac_checkpoint_preserved': checkpoint['preserved']}
        report = {'schema_version': 'snippy-production-report-v1', 'generated_at': audit.now(),
            'root': str(self.root), 'mode': 'final_verification' if self.verify_media else 'snapshot',
            'requested': self.expected_count, 'stage_counts': dict(counts), 'disposition_counts': dict(dispositions),
            'covered': sum(r['disposed'] for r in coverage), 'covered_ids': [r['candidate_id'] for r in coverage if r['disposed']],
            'remaining': len(pending), 'pending_ids': pending, 'source_failed': dispositions['source_failed'],
            'other_failed': dispositions['other_failed'], 'awaiting_astra': counts['awaiting_astra'],
            'published_complete': sum(counts[k] for k in PUBLISHED),
            'all_completed': all(r['complete'] for r in coverage) and len(coverage) == self.expected_count,
            'luna_cost_usd': api['luna_cost_usd'], 'api': api, 'checkpoint': checkpoint,
            'gcs': {**transfer_totals, 'unique_transfer_receipts': len(self.transfers),
                'receipts': list(self.transfers.values()), 'measurement': 'HTTP body/request bounds; excludes TLS overhead and unreceipted playback. Not billed egress.',
                'published_object_bytes': sum(r.get('uploaded_bytes', 0) for r in self.receipts.values()),
                'local_clip_file_bytes': sum(p.stat().st_size for p in media_paths), 'local_clip_files': len(media_paths)},
            'bigquery': {'unique_jobs': len(self.jobs), 'known_bytes_billed': sum(j['bytes_billed'] for j in self.jobs.values() if numeric(j.get('bytes_billed'))),
                'unknown_billed_job_ids': [k for k, j in self.jobs.items() if not numeric(j.get('bytes_billed'))],
                'jobs': list(self.jobs.values()), 'scope': 'Durable job receipts only; unreceipted queries and currency charges unknown.'},
            'checks': checks, 'integrity_passed': not self.errors,
            'verified': self.verify_media, 'passed': self.verify_media and all(checks.values()),
            'errors': self.errors, 'coverage': coverage}
        audit.atomic(self.root / 'production-report.json', report)
        csv_path = self.root / 'coverage.csv'
        temp = csv_path.with_suffix('.csv.tmp')
        with temp.open('w', newline='', encoding='utf-8') as stream:
            fields = ['candidate_id', 'lane', 'status', 'stage', 'disposition', 'failure_category', 'disposed', 'complete', 'checkpoint_origin', 'record_path', 'record_sha256', 'reason', 'evidence']
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            for row in coverage:
                writer.writerow({**row, 'evidence': json.dumps(row['evidence'], ensure_ascii=False, sort_keys=True)})
        temp.replace(csv_path)
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--verify', action='store_true', help='Final verifier: hash media and fail on pending, failed, or invalid receipts')
    args = parser.parse_args(argv)
    report = Reporter(args.root, verify_media=args.verify).run()
    print(json.dumps({k: report[k] for k in ('requested', 'covered', 'remaining', 'source_failed', 'other_failed', 'awaiting_astra', 'published_complete', 'luna_cost_usd', 'integrity_passed', 'verified', 'passed')}))
    return 0 if (report['passed'] if args.verify else report['integrity_passed']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
