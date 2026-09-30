#!/usr/bin/env python3
"""Offline cloud usage for one frozen wave; never queries services or prices."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlparse

import audit

BUCKET = 'snippysaurus-clips'
SAFE_ID = re.compile(r'[A-Za-z0-9_-]{1,80}')
SAFE_BATCH = re.compile(r'[A-Za-z0-9_-]{1,128}')


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def nonnegative_int(value):
    return type(value) is int and value >= 0


class Usage:
    def __init__(self, root, experiment_id=None, scope='experiment'):
        self.root = Path(root).resolve()
        self.base = self.root
        self.errors, self.evidence, self.archive_hashes = [], {}, None
        self.scope = scope
        if experiment_id and not SAFE_ID.fullmatch(experiment_id):
            raise ValueError('Unsafe experiment ID')
        current = self.read(self.root / 'experiment-plan.json', required=False)
        if scope == 'experiment' and experiment_id and current.get('experiment_id') != experiment_id:
            archive = self.root / 'experiments' / experiment_id
            self.base = archive / 'artifacts'
            manifest_path = archive / 'archive-manifest.json'
            manifest = self.read(manifest_path)
            if manifest.get('experiment_id') != experiment_id:
                raise ValueError('Archive experiment identity differs')
            transition = self.read(self.root / 'experiment-transition.json', required=False)
            if transition.get('first_experiment_id') == experiment_id:
                if self.evidence[str(manifest_path)]['sha256'] != transition.get('archive_manifest_sha256'):
                    raise ValueError('Archive manifest differs from transition receipt')
            self.archive_hashes = {}
            for item in manifest.get('files', []):
                relative = item['path']
                path = (archive / relative).resolve()
                if not path.is_relative_to(archive.resolve()):
                    raise ValueError('Archive manifest path escapes archive')
                if str(path) in self.archive_hashes:
                    raise ValueError('Duplicate archive artifact path')
                self.archive_hashes[str(path)] = item
        if scope == 'first-shadow':
            if current.get('plan_sha256') != audit.digest({k: v for k, v in current.items() if k != 'plan_sha256'}):
                raise ValueError('Frozen first-wave baseline signature changed')
            baseline = set(current.get('baseline_record_sha256', {}))
            matches = []
            for path in (self.root / 'batches').glob('*/batch-plan.json'):
                batch = self.read(path)
                ids = batch.get('slot_candidate_ids', [])
                if len(ids) == 5 and set(ids).issubset(baseline):
                    matches.append((path, batch))
            if len(matches) != 1:
                raise ValueError('Exactly one original five-candidate Shadow batch must match the frozen wave baseline')
            path, batch = matches[0]
            self.plan = {'experiment_id': 'first-shadow-five', 'candidate_ids': batch['slot_candidate_ids'],
                'slots': [{'batch_name': path.parent.name, 'candidate_ids': batch['slot_candidate_ids']}],
                'source_batch_plan_sha256': self.evidence[str(path)]['sha256'], 'baseline_record_sha256': {}}
            self.plan['plan_sha256'] = audit.digest(self.plan)
        else:
            self.plan = self.read(self.base / ('stream-plan.json' if scope == 'stream' else 'experiment-plan.json'))
        plan = self.plan
        self.experiment_id = plan.get('experiment_id') or plan.get('stream_id')
        ids = plan.get('candidate_ids', [])
        slots = plan.get('slots', [])
        if (plan.get('plan_sha256') != audit.digest({k: v for k, v in plan.items() if k != 'plan_sha256'})
                or len(ids) != len(set(ids)) or not 1 <= len(ids) <= 50
                or (scope == 'experiment' and (len(ids) != 50 or len(slots) != 10))
                or (scope == 'first-shadow' and len(ids) != 5)
                or (scope == 'stream' and (len(ids) > 5 or len(ids) != plan.get('target_candidate_count')))
                or any(not isinstance(vid, str) or not SAFE_ID.fullmatch(vid) for vid in ids)
                or any(not 1 <= len(slot.get('candidate_ids', [])) <= 5 for slot in slots)
                or [vid for slot in slots for vid in slot['candidate_ids']] != ids
                or set(ids) & set(plan.get('baseline_record_sha256', {}))
                or (experiment_id and self.experiment_id != experiment_id)):
            raise ValueError('Frozen wave plan identity/membership is invalid')
        self.ids = set(ids)

    def read(self, path, required=True):
        path = Path(path)
        resolved = path.resolve()
        if not resolved.is_relative_to(self.root):
            raise ValueError('Evidence path escapes run root')
        if not path.exists() and not required:
            return {}
        data = path.read_bytes()
        item = {'path': str(path), 'sha256': sha_bytes(data), 'bytes': len(data)}
        if self.archive_hashes is not None and resolved.is_relative_to(self.base.resolve()):
            expected = self.archive_hashes.get(str(resolved))
            if not expected or expected['sha256'] != item['sha256'] or expected['size'] != len(data):
                raise ValueError('Archived evidence missing from manifest or changed: ' + str(path))
        self.evidence[str(path)] = item
        return json.loads(data)

    def error(self, code, path, **details):
        self.errors.append({'code': code, 'path': str(path), **details})

    def build(self):
        jobs, objects, receipts, attempts = {}, {}, [], []

        def add_jobs(raw, path, cid, successful_receipt):
            for job in raw.get('query_jobs', []):
                jid, billed = job.get('job_id'), job.get('bytes_billed')
                if not isinstance(jid, str) or not jid:
                    self.error('query_job_identity_missing', path, candidate_id=cid)
                    continue
                if billed is not None and not nonnegative_int(billed):
                    self.error('invalid_query_billed_bytes', path, job_id=jid)
                    continue
                entry = {'job_id': jid, 'bytes_billed': billed, 'cache_hit': job.get('cache_hit'),
                         'candidate_id': cid, 'successful_publication_receipt': successful_receipt,
                         'evidence_paths': [str(path)]}
                prior = jobs.get(jid)
                if prior:
                    if any(prior[key] != entry[key] for key in ('bytes_billed', 'cache_hit', 'candidate_id')):
                        self.error('conflicting_query_job_identity_or_usage', path, job_id=jid)
                    prior['successful_publication_receipt'] |= successful_receipt
                    prior['evidence_paths'].append(str(path))
                else:
                    jobs[jid] = entry

        for cid in self.plan['candidate_ids']:
            receipt_path = self.base / 'publications' / (cid + '.json')
            if receipt_path.exists():
                raw = self.read(receipt_path)
                if raw.get('video_id') != cid or raw.get('passed') is not True:
                    self.error('invalid_fresh_publication_receipt', receipt_path)
                else:
                    add_jobs(raw, receipt_path, cid, True)
                    amount, generation = raw.get('uploaded_bytes'), raw.get('gcs_generation')
                    parsed = urlparse(raw.get('gcs_url', ''))
                    prefix = '/' + BUCKET + '/'
                    if (not nonnegative_int(amount) or not str(generation or '')
                            or parsed.scheme != 'https' or parsed.netloc != 'storage.googleapis.com'
                            or not parsed.path.startswith(prefix) or parsed.query or parsed.fragment):
                        self.error('invalid_output_object_receipt', receipt_path)
                        continue
                    name = unquote(parsed.path[len(prefix):])
                    key = (BUCKET, name, str(generation))
                    obj = {'candidate_id': cid, 'bucket': BUCKET, 'name': name,
                           'generation': str(generation), 'verified_object_bytes': amount,
                           'media_sha256': raw.get('media_sha256'),
                           'storageClass': raw.get('storageClass'), 'receipt_paths': [str(receipt_path)]}
                    if key in objects:
                        prior = objects[key]
                        if any(prior[k] != obj[k] for k in ('candidate_id', 'verified_object_bytes', 'media_sha256')):
                            self.error('conflicting_output_object_generation', receipt_path)
                        prior['receipt_paths'].append(str(receipt_path))
                    else:
                        objects[key] = obj
                    receipts.append({'candidate_id': cid, 'path': str(receipt_path), 'object_generation': str(generation)})
                    if 'query_bytes_billed' in raw and all(nonnegative_int(j.get('bytes_billed')) for j in raw.get('query_jobs', [])):
                        local_jobs = {j['job_id']: j['bytes_billed'] for j in raw.get('query_jobs', []) if j.get('job_id')}
                        if sum(local_jobs.values()) != raw['query_bytes_billed']:
                            self.error('receipt_query_total_differs_from_unique_jobs', receipt_path)
            attempt_path = self.base / 'publication-attempts' / (cid + '.json')
            if attempt_path.exists():
                raw = self.read(attempt_path)
                if raw.get('candidate_id') != cid:
                    self.error('publication_attempt_identity_differs', attempt_path)
                    continue
                add_jobs(raw, attempt_path, cid, False)
                attempts.append({'candidate_id': cid, 'status': raw.get('status'), 'path': str(attempt_path)})

        transfer_paths = {path for cid in self.ids for path in (self.base / 'rendered').glob(cid + '-*/transfer.json')}
        for slot in self.plan['slots']:
            name = slot['batch_name']
            if not isinstance(name, str) or not SAFE_BATCH.fullmatch(name):
                raise ValueError('Unsafe batch namespace')
            transfer_paths.update((self.base / 'batches' / name).rglob('transfer.json'))
        transfers, source_metadata, statuses, transfer_hashes = [], [], Counter(), {}
        for path in sorted(transfer_paths):
            recipe_path = path.parent / 'recipe.json'
            if not recipe_path.exists():
                if any(path.parent.name.startswith(cid + '-') for cid in self.ids):
                    self.error('scoped_transfer_recipe_missing', path)
                continue
            recipe = self.read(recipe_path)
            cid = recipe.get('candidate_id')
            if cid not in self.ids:
                continue
            raw = self.read(path)
            identity = audit.digest(raw)
            if identity in transfer_hashes:
                if transfer_hashes[identity] != cid:
                    self.error('duplicate_transfer_receipt_candidate_differs', path)
                continue  # A copied receipt is not another source GET.
            transfer_hashes[identity] = cid
            body, response_upper, requested = (raw.get(k) for k in ('upstream_body_bytes_read', 'conservative_response_bytes_upper_bound', 'upstream_requested_bytes'))
            if not all(nonnegative_int(x) for x in (body, response_upper, requested)) or not body <= response_upper <= requested:
                self.error('invalid_source_transfer_bounds', path)
                continue
            pages = [page for req in raw.get('requests', []) for page in req.get('pages', []) if not page.get('cache_hit')]
            response_count = sum('status' in page for page in pages)
            for page in pages:
                statuses[str(page.get('status', 'response_unobserved'))] += 1
            if pages and (sum(p.get('bytes_read', 0) for p in pages) != body
                          or sum(p.get('requested_bytes', 0) for p in pages) != requested):
                self.error('source_page_totals_differ', path)
            transfers.append({'candidate_id': cid, 'path': str(path), 'source_generation': raw.get('source_generation'),
                'body_bytes_read': body, 'response_content_length_upper_bound': response_upper,
                'requested_bytes_upper_bound': requested, 'range_request_intents': len(pages),
                'range_http_responses_observed': response_count,
                'range_intents_without_observed_response': len(pages) - response_count,
                'original_cache_body_bytes_read': raw.get('original_cache_body_bytes_read', 0),
                'original_cache_page_hits': raw.get('original_cache_page_hits', 0),
                'errors': raw.get('errors', [])})
            source_path = path.parent / 'source.json'
            if source_path.exists():
                source = self.read(source_path)
                if source.get('bucket') != BUCKET or str(source.get('generation')) != str(raw.get('source_generation')):
                    self.error('source_metadata_identity_differs', source_path)
                source_metadata.append({'candidate_id': cid, 'path': str(source_path),
                    **{k: source.get(k) for k in ('bucket', 'name', 'generation', 'size', 'storageClass')}})

        metadata_path = self.base / 'storage-metadata.json'
        bucket_metadata = self.read(metadata_path, required=False)
        bucket_verified = (bucket_metadata.get('status') == 'verified' and bucket_metadata.get('name') == BUCKET
                           and all(bucket_metadata.get(k) for k in ('location', 'locationType', 'storageClass')))
        output_metadata = self.read(self.base / 'output-storage-metadata.json', required=False)
        if output_metadata.get('schema_version') == 'snippy-output-storage-metadata-v2':
            snapshots = [item for item in output_metadata.get('snapshots', [])
                         if item.get('experiment_id') == self.experiment_id]
            if len(snapshots) > 1:
                self.error('duplicate_output_metadata_scope', self.base / 'output-storage-metadata.json')
            output_metadata = snapshots[0] if snapshots else {}
        if output_metadata:
            expected = output_inventory(list(objects.values()))
            if (output_metadata.get('experiment_id') != self.experiment_id
                    or output_metadata.get('plan_sha256') != self.plan['plan_sha256']
                    or output_metadata.get('objects_inventory_sha256') != audit.digest(expected)):
                self.error('output_metadata_scope_or_inventory_differs', self.base / 'output-storage-metadata.json')
            else:
                for item in output_metadata.get('objects', []):
                    key = (BUCKET, item['name'], str(item['expected_generation']))
                    obj = objects.get(key)
                    if obj is None:
                        self.error('output_metadata_object_outside_receipts', self.base / 'output-storage-metadata.json')
                    elif item.get('status') == 'verified':
                        observed = item.get('metadata', {})
                        if (observed.get('bucket') != BUCKET or observed.get('name') != obj['name']
                                or str(observed.get('generation')) != obj['generation']
                                or str(observed.get('size')) != str(obj['verified_object_bytes'])
                                or not observed.get('storageClass')):
                            self.error('output_metadata_generation_or_size_mismatch', self.base / 'output-storage-metadata.json')
                        else:
                            obj['storageClass'] = observed['storageClass']
                            obj['storageClass_evidence'] = str(self.base / 'output-storage-metadata.json')
                    elif item.get('status') == 'identity_mismatch':
                        self.error('output_metadata_generation_or_size_mismatch', self.base / 'output-storage-metadata.json')
        status = self.read(self.base / ('stream-status.json' if self.scope == 'stream' else 'experiment-status.json'), required=False)
        benchmark = self.read(self.base / 'benchmark-report.json', required=False)
        model_cost = benchmark.get('api', {}).get('usage_derived_cost_usd') if benchmark.get('experiment_id') == self.experiment_id else None
        api_responses, unknown_api = {}, []
        for slot in self.plan['slots']:
            for response_path in (self.base / 'batches' / slot['batch_name']).glob('*/response.json'):
                raw = self.read(response_path)
                rid = raw.get('id')
                usage = raw.get('usage') or {}
                details = usage.get('input_tokens_details') or {} if isinstance(usage, dict) else {}
                valid_usage = (isinstance(usage, dict) and isinstance(details, dict)
                    and all(nonnegative_int(usage.get(k)) for k in ('input_tokens', 'output_tokens'))
                    and all(nonnegative_int(details.get(k, 0)) for k in ('cached_tokens', 'cache_write_tokens')))
                if valid_usage:
                    valid_usage = details.get('cached_tokens', 0) + details.get('cache_write_tokens', 0) <= usage['input_tokens']
                if not rid or not str(raw.get('model', '')).startswith('gpt-6-luna') or not valid_usage:
                    self.error('invalid_model_usage_response', response_path)
                    continue
                identity = audit.digest(raw)
                if rid in api_responses and api_responses[rid]['sha256'] != identity:
                    self.error('conflicting_model_response_identity', response_path)
                api_responses[rid] = {'response_id': rid, 'sha256': identity, 'cost_usd': audit.price(raw)}
            for state_path in (self.base / 'batches' / slot['batch_name']).glob('*/call-state.json'):
                state = self.read(state_path)
                if not state_path.with_name('response.json').exists() and state.get('status') in ('started', 'unknown_charge'):
                    unknown_api.append(str(state_path))
        saved_model_cost = sum(row['cost_usd'] for row in api_responses.values())
        if model_cost is not None and abs(model_cost - saved_model_cost) > 1e-9:
            self.error('benchmark_model_cost_differs_from_saved_responses', self.base / 'benchmark-report.json')
        model_cost = saved_model_cost
        totals = {key: sum(row[key] for row in transfers) for key in
                  ('body_bytes_read', 'response_content_length_upper_bound', 'requested_bytes_upper_bound',
                   'range_request_intents', 'range_http_responses_observed', 'range_intents_without_observed_response')}
        totals['original_cache_body_bytes_read'] = sum(row['original_cache_body_bytes_read'] for row in transfers)
        totals['original_cache_page_hits'] = sum(row['original_cache_page_hits'] for row in transfers)
        billed = sum(job['bytes_billed'] for job in jobs.values() if job['bytes_billed'] is not None)
        unknown_jobs = [job['job_id'] for job in jobs.values() if job['bytes_billed'] is None
                        or (job['bytes_billed'] == 0 and job['cache_hit'] is None)]
        output_bytes = sum(obj['verified_object_bytes'] for obj in objects.values())
        limits = [
            'Saved-artifact snapshot only; neither a Cloud Billing export nor an invoice.',
            'BigQuery includes only query jobs saved for these fresh publication receipts/attempts. Historical verification, startup preflight, Mac checkpoint and other waves are excluded.',
            'Publication-attempt files retain the latest invocation. Earlier overwritten invocations or a failure before b.query returns a job handle are unobserved; saved totals are not guaranteed whole-account totals.',
            'Publisher uploaded_bytes means verified output object size. Receipts do not say whether an upload POST happened or an existing object was reused. Actual upload wire bytes and upload counts are unknown.',
            'Output object bytes are not a bound on all upload traffic: failed/unreceipted uploads, retries and protocol overhead are unobserved.',
            'Source body bytes were actually read. Response lengths and requested lengths are upper bounds including cancelled unread data, excluding HTTP/TLS overhead. These are not billed egress bytes.',
            'Range intents can precede network dispatch; response statuses prove returned HTTP responses. Saved source metadata files prove responses, not a complete operation count.',
            'Only final-report metadata GETs have dedicated operation receipts. Publisher metadata GETs, upload POSTs, public playback GETs, site API calls and hidden transport retries remain unobserved.',
            'Bucket default storage class does not establish each output object storage class. Source object metadata applies only to the recorded source objects.',
            'No dollar cloud estimate is asserted without verified billing location, operation classes/rates, egress destination, retention time and billing adjustments.',
        ]
        if not bucket_verified:
            limits.append('Bucket metadata is unverified: ' + (str(bucket_metadata.get('http_status')) if bucket_metadata else 'no saved query') + '; location/locationType/default storageClass unknown.')
        return {'schema_version': 'snippy-cloud-usage-v1', 'created_at': audit.now(), 'experiment_id': self.experiment_id,
            'scope': {'kind': self.scope, 'candidate_ids': self.plan['candidate_ids'], 'candidate_count': len(self.ids), 'plan_sha256': self.plan['plan_sha256'],
                      'artifact_base': str(self.base), 'archived': self.base != self.root,
                      'fresh_publication_receipts_only': True, 'historical_verification_excluded': True},
            'bucket': {'name': BUCKET, 'metadata_verified': bucket_verified, 'metadata_receipt': bucket_metadata,
                       'location': bucket_metadata.get('location') if bucket_verified else None,
                       'locationType': bucket_metadata.get('locationType') if bucket_verified else None,
                       'default_storageClass': bucket_metadata.get('storageClass') if bucket_verified else None},
            'outputs': {'unique_verified_objects': len(objects), 'verified_output_object_bytes': output_bytes,
                        'verified_output_object_gib': output_bytes / 1024**3, 'actual_upload_wire_bytes': None,
                        'upload_posts_observed': None, 'objects_with_unobserved_storageClass': sum(not obj['storageClass'] for obj in objects.values()),
                        'observed_output_storage_classes': dict(Counter(obj['storageClass'] or 'unobserved' for obj in objects.values())),
                        'objects': list(objects.values()), 'publication_receipts': receipts},
            'bigquery': {'unique_publication_query_jobs': len(jobs), 'recorded_bytes_billed': billed,
                         'recorded_tib_billed': billed / 1024**4,
                         'successful_publication_job_bytes_billed': sum(j['bytes_billed'] or 0 for j in jobs.values() if j['successful_publication_receipt']),
                         'attempt_only_job_bytes_billed': sum(j['bytes_billed'] or 0 for j in jobs.values() if not j['successful_publication_receipt']),
                         'unknown_or_ambiguous_billing_job_ids': unknown_jobs, 'jobs': list(jobs.values()), 'publication_attempts': attempts},
            'source_downloads': {**totals, 'body_gib_read': totals['body_bytes_read'] / 1024**3,
                                 'requested_gib_upper_bound': totals['requested_bytes_upper_bound'] / 1024**3,
                                 'http_status_counts': dict(statuses), 'transfers': transfers,
                                 'source_metadata_response_artifacts': len(source_metadata),
                                 'observed_source_storage_classes': dict(Counter(row['storageClass'] or 'unobserved' for row in source_metadata)),
                                 'source_metadata': source_metadata},
            'operations': {'source_range_request_intents': totals['range_request_intents'],
                           'source_range_http_responses_observed': totals['range_http_responses_observed'],
                           'source_metadata_response_artifacts': len(source_metadata),
                           'bucket_metadata_saved_explicit_requests': bucket_metadata.get('explicit_request_count', 0),
                           'bucket_metadata_current_wave_explicit_requests': bucket_metadata.get('explicit_request_count', 0) if bucket_metadata.get('experiment_id') == self.experiment_id else 0,
                           'bucket_metadata_http_status': bucket_metadata.get('http_status'),
                           'upload_posts': None,
                           'final_report_output_metadata_request_intents': output_metadata.get('requests_started', 0),
                           'final_report_output_metadata_http_responses': output_metadata.get('http_responses_observed', 0),
                           'publisher_output_metadata_gets': None, 'playback_gets': None,
                           'billable_operation_total': None},
            'costs': {'cloud_invoice_usd': None, 'cloud_estimate_usd': None, 'model_api_usage_derived_usd': model_cost,
                      'model_response_ids': sorted(api_responses), 'model_unknown_charge_paths': unknown_api,
                      'local_benchmarks_new_luna_api_usage_usd': 0,
                      'fixed_subscriptions': {name: {'allocated_usd': None, 'included_in_incremental_usage': False,
                          'incremental_usd_under_existing_subscription_assumption': 0} for name in ('Shadow', 'ChatGPT')},
                      'illustrative_calculator': {
                          'not_an_invoice_or_account_cost_bound': True,
                          'basis': 'Official pricing checked 2026-09-30. Location, billing plan, allowances, actual billable egress and retention remain unverified.',
                          'source_egress': {'assumed_usd_per_gib': .12,
                              'assumption': 'First 10 TiB/month internet transfer to worldwide destinations excluding China/Australia; no free-tier/discount adjustment.',
                              'read_bytes_scenario_usd': totals['body_bytes_read'] / 1024**3 * .12,
                              'requested_bytes_scenario_usd': totals['requested_bytes_upper_bound'] / 1024**3 * .12},
                          'bigquery': {'assumed_usd_per_tib': 6.25, 'recorded_usage_before_allowances_usd': billed / 1024**4 * 6.25,
                              'assumption': 'On-demand starting list rate, before monthly free 1 TiB/credits; reservations/location may differ.'},
                          'source_class_b_gets': {'assumed_usd_per_1000': .0004,
                              'observed_successful_responses_scenario_usd': (sum(count for code, count in statuses.items() if code in ('200', '206')) + len(source_metadata)) / 1000 * .0004,
                              'assumption': 'Standard flat-namespace Class B; observed successful range and saved source metadata responses only; other calls unpriced.'},
                          'storage_formula': 'output GiB * applicable object class/location USD per GiB-month * retained fraction of month; class observations above, location and retention remain unverified',
                          'references': ['https://cloud.google.com/storage/pricing', 'https://cloud.google.com/bigquery/pricing']},
                      'formulas': {'bigquery': 'recorded_tib_billed * applicable USD/TiB, before billing adjustments',
                                   'storage': 'verified_output_object_gib * retained fraction of month * applicable storage USD/GiB-month',
                                   'source_transfer': 'billable egress GiB * destination/location rate; read bytes and requested bound are evidence, not billed egress'}},
            'checks': {'evidence_integrity': not self.errors, 'wave_finished':
                       ((status.get('experiment_id') or status.get('stream_id')) == self.experiment_id and status.get('phase') in ('experiment_completed', 'stream_completed'))
                       or (self.scope == 'first-shadow' and all(self.read(self.root / 'records' / (cid + '.json')).get('status') in ('published', 'already_published', 'awaiting_astra', 'failed') for cid in self.ids)),
                       'scope_stopped': bool(status.get('drained_at')) or
                       ((status.get('experiment_id') or status.get('stream_id')) == self.experiment_id
                        and status.get('phase') in ('experiment_completed', 'stream_completed')),
                       'bucket_metadata_verified': bucket_verified, 'query_billing_fields_complete': not unknown_jobs},
            'errors': self.errors, 'limitations': limits, 'evidence': list(self.evidence.values()),
            'references': {'bucket_metadata': 'https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/get',
                           'bucket_fields': 'https://docs.cloud.google.com/storage/docs/json_api/v1/buckets',
                           'bigquery_job_statistics': 'https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/Job'}}


def output_inventory(objects):
    return sorted([{'bucket': obj['bucket'], 'name': obj['name'], 'generation': obj['generation'],
                    'size': obj['verified_object_bytes']} for obj in objects], key=lambda row: (row['bucket'], row['name'], row['generation']))


def fetch_output_metadata(usage, report, private_env_file=None, session=None, *, output_path=None, allow_stopped=False):
    """One final bounded metadata pass. Existing/pending receipts never retry."""
    settled = report['checks']['wave_finished'] or (allow_stopped and report['checks'].get('scope_stopped'))
    if usage.base != usage.root or not settled or not report['checks']['evidence_integrity']:
        raise ValueError('Output metadata fetch requires the completed current wave with valid evidence')
    path = Path(output_path) if output_path is not None else usage.root / 'output-storage-metadata.json'
    inventory = output_inventory(report['outputs']['objects'])
    signature = audit.digest(inventory)
    if path.exists():
        saved = usage.read(path)
        if (saved.get('experiment_id') != usage.experiment_id or saved.get('plan_sha256') != usage.plan['plan_sha256']
                or saved.get('objects_inventory_sha256') != signature):
            raise ValueError('Existing output metadata belongs to a different scope; archive/reset it through the wave transition')
        return saved
    receipt = {'schema_version': 'snippy-output-storage-metadata-v1', 'experiment_id': usage.experiment_id,
               'plan_sha256': usage.plan['plan_sha256'], 'objects_inventory_sha256': signature,
               'created_at': audit.now(), 'status': 'in_progress', 'operation': 'storage.objects.get',
               'fields': 'name,bucket,generation,size,storageClass', 'metadata_only': True,
               'requests_started': 0, 'http_responses_observed': 0, 'objects': []}
    audit.atomic(path, receipt)
    owns_session = False
    try:
        if inventory and session is None:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession
            if private_env_file:
                from production import private_environment
                private_environment(private_env_file)
            credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/devstorage.read_only'])
            session = AuthorizedSession(credentials, max_refresh_attempts=0)
            owns_session = True
        from urllib.parse import quote
        for obj in inventory:
            item = {'name': obj['name'], 'expected_generation': obj['generation'], 'expected_size': obj['size'],
                    'started_at': audit.now(), 'status': 'request_pending'}
            receipt['objects'].append(item)
            receipt['requests_started'] += 1
            audit.atomic(path, receipt)
            try:
                response = session.get('https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + quote(obj['name'], safe=''),
                    params={'fields': receipt['fields'], 'generation': obj['generation']}, timeout=30, allow_redirects=False)
                item['http_status'] = response.status_code
                receipt['http_responses_observed'] += 1
                if response.status_code == 200:
                    payload = response.json()
                    item['metadata'] = {key: payload.get(key) for key in ('name', 'bucket', 'generation', 'size', 'storageClass')}
                    matched = (payload.get('bucket') == BUCKET and payload.get('name') == obj['name']
                               and str(payload.get('generation')) == obj['generation']
                               and str(payload.get('size')) == str(obj['size']) and bool(payload.get('storageClass')))
                    item['status'] = 'verified' if matched else 'identity_mismatch'
                else:
                    item['status'] = 'permission_denied' if response.status_code in (401, 403) else 'http_error'
                response.close()
            except Exception as exc:
                item['status'], item['error_type'] = 'transport_error', type(exc).__name__
            item['finished_at'] = audit.now()
            audit.atomic(path, receipt)
        receipt['status'] = 'verified' if all(item['status'] == 'verified' for item in receipt['objects']) else 'partial'
    except Exception as exc:
        receipt['status'], receipt['error_type'] = 'failed', type(exc).__name__
    finally:
        if owns_session:
            session.close()
        receipt['finished_at'] = audit.now()
        audit.atomic(path, receipt)
    return receipt


def markdown(report):
    bq, source, outputs, bucket = (report[k] for k in ('bigquery', 'source_downloads', 'outputs', 'bucket'))
    rows = [f'# Cloud usage: {report["experiment_id"]}', '',
        f'Scoped to the exact {report["scope"]["candidate_count"]} fresh candidates. Snapshot {report["created_at"]}. Wave finished: {report["checks"]["wave_finished"]}.', '',
        '| Measurement | Saved evidence |', '|---|---|',
        f'| Verified fresh output objects | {outputs["unique_verified_objects"]}; {outputs["verified_output_object_bytes"]:,} bytes ({outputs["verified_output_object_gib"]:.6f} GiB) |',
        '| Actual upload wire bytes / upload POST count | Unobserved; object size does not prove a new upload |',
        f'| Fresh publication BigQuery jobs | {bq["unique_publication_query_jobs"]} unique job IDs; {bq["recorded_bytes_billed"]:,} recorded billed bytes ({bq["recorded_tib_billed"]:.9f} TiB) |',
        f'| Source body bytes actually read | {source["body_bytes_read"]:,} |',
        f'| Source declared response / requested upper bounds | {source["response_content_length_upper_bound"]:,} / {source["requested_bytes_upper_bound"]:,} bytes |',
        f'| Source range intents / HTTP responses | {source["range_request_intents"]} / {source["range_http_responses_observed"]} |',
        f'| Bucket location / type / default class | {bucket["location"] or "unverified"} / {bucket["locationType"] or "unverified"} / {bucket["default_storageClass"] or "unverified"} |',
        f'| Source object storage classes observed | {json.dumps(source["observed_source_storage_classes"])} |',
        f'| Output objects without recorded storage class | {outputs["objects_with_unobserved_storageClass"]} |',
        f'| Output object storage classes observed | {json.dumps(outputs["observed_output_storage_classes"])} |', '',
        'Historical verification, startup preflight, Mac checkpoint and other waves are excluded from BigQuery totals. Shadow and ChatGPT subscriptions are fixed costs kept separate; no allocation or zero-cost claim is made.', '',
        'These measurements are not an invoice. Actual cloud dollar cost remains unknown. The conditional calculator below does not establish the account bill or a total-cost bound.', '']
    calculator = report['costs']['illustrative_calculator']
    egress, bq_cost = calculator['source_egress'], calculator['bigquery']
    rows += [f"Saved Luna API usage-derived estimate: ${report['costs']['model_api_usage_derived_usd']:.9f}; unresolved charge records: {len(report['costs']['model_unknown_charge_paths'])}.",
        f"If internet egress is $0.12/GiB, read-byte scenario is ${egress['read_bytes_scenario_usd']:.6f}; requested-byte scenario is ${egress['requested_bytes_scenario_usd']:.6f}. These byte scenarios are not measured billed egress.",
        f"If BigQuery uses $6.25/TiB on-demand pricing, the saved billed-byte quantity prices at ${bq_cost['recorded_usage_before_allowances_usd']:.6f} before allowances/credits. Free-tier use and reservation pricing are unknown.",
        'Storage remains a formula because bucket location and retention are unknown; observed output classes are listed above. Local encoder/ASR benchmarks make no Luna API calls. Shadow/ChatGPT incremental subscription cost is $0 only under the already-owned subscription assumption; amortized allocation remains unknown.', '',
        'Calculator sources checked 2026-09-30: [Cloud Storage pricing](https://cloud.google.com/storage/pricing), [BigQuery pricing](https://cloud.google.com/bigquery/pricing).', '']
    rows.extend('- ' + item for item in report['limitations'])
    rows += ['', 'References: [bucket metadata](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/get), [storage fields](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets), [BigQuery job statistics](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/Job).', '']
    return '\n'.join(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--experiment-id')
    parser.add_argument('--scope', choices=['experiment', 'first-shadow', 'stream'], default='experiment')
    parser.add_argument('--fetch-output-metadata', action='store_true', help='One final, bounded metadata-only pass after current wave completes; never retries saved attempts')
    parser.add_argument('--private-env-file', type=Path)
    args = parser.parse_args()
    usage = Usage(args.root, args.experiment_id, args.scope)
    report = usage.build()
    if args.fetch_output_metadata:
        fetch_output_metadata(usage, report, args.private_env_file)
        usage = Usage(args.root, args.experiment_id, args.scope)
        report = usage.build()
    stem = 'cloud-usage' if usage.base == usage.root and args.scope == 'experiment' else 'cloud-usage-' + usage.experiment_id
    target = usage.root / (stem + '.json')
    audit.atomic(target, report)
    target.with_suffix('.md').write_text(markdown(report), encoding='utf-8')
    print(json.dumps({'path': str(target), 'checks': report['checks'],
                      'fresh_output_bytes': report['outputs']['verified_output_object_bytes'],
                      'publication_query_bytes_billed': report['bigquery']['recorded_bytes_billed']}))
    return 0 if report['checks']['evidence_integrity'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
