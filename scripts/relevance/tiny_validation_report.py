#!/usr/bin/env python3
"""Offline verifier for one frozen <=5 candidate streaming trial, not the 1644 queue.

Reads only local receipts and hashes the trial's final media. No model, network,
render, publication or retry calls. Always writes a report, including failures.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re

import audit
import luna_batch_qa as luna
from benchmark_report import elapsed, overlap, timestamp
from production_report import FAILED, SOURCE_ERROR, flattened_numbers, numeric, sha

STAGE = re.compile(r'^(\d{4}-\d\d-\d\dT\S+)\s+([A-Za-z0-9_-]{11})\s+(\w+)\s*$')


class TinyReporter:
    def __init__(self, root, stream_id=None):
        self.root, self.expected_id = Path(root).resolve(), stream_id
        self.errors, self.hashes = [], {}

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

    def hash(self, path):
        path = Path(path)
        if path not in self.hashes:
            try:
                self.hashes[path] = sha(path)
            except OSError:
                self.error('missing_hash_bound_file', path)
                self.hashes[path] = None
        return self.hashes[path]

    def path(self, value):
        path = Path(value)
        result = (path if path.is_absolute() else self.root / path).resolve()
        if not result.is_relative_to(self.root):
            raise ValueError('Trial evidence path escapes the run root')
        return result

    def stage_events(self, ids, started_at):
        result, seen = defaultdict(list), set()
        for path in sorted(self.root.glob('*.log')):
            with path.open(encoding='utf-8-sig', errors='replace') as stream:
                for number, line in enumerate(stream, 1):
                    match = STAGE.match(line.strip())
                    if not match:
                        continue
                    when, vid, stage = match.groups()
                    if vid not in ids or timestamp(when) is None or (timestamp(started_at) is not None and timestamp(when) < timestamp(started_at)):
                        continue
                    key = (when, vid, stage)
                    if key not in seen:
                        seen.add(key)
                        result[vid].append({'time': when, 'stage': stage, 'path': str(path), 'line': number})
        for events in result.values():
            events.sort(key=lambda e: timestamp(e['time']))
        return result

    def final_evidence(self, vid, record):
        evidence = {'required': record.get('status') in {'published', 'already_published'}, 'checked': False}
        held_artifacts = None
        directory = record.get('final_directory') or record.get('directory')
        if record.get('handoff'):
            held_path = self.path(record['handoff']).with_suffix('.json')
            held = self.read(held_path) or {}
            artifacts = held.get('artifacts', {})
            held_artifacts = artifacts
            evidence['handoff_path'] = str(held_path)
            directory = str(self.path(artifacts['media_path']).parent) if artifacts.get('media_path') else directory
            evidence['required'] = True
        if record.get('status') == 'awaiting_astra' and record.get('stage') != 'proposal':
            evidence['required'] = True
        if not directory:
            if evidence['required']:
                self.error('final_media_directory_missing', candidate_id=vid)
            return evidence
        directory = self.path(directory)
        evidence['directory'] = str(directory)
        if not evidence['required'] and not (directory / 'asr/evidence.json').exists():
            evidence['not_checked_reason'] = 'No verified final ASR required for this pending/preparation-failed record'
            return evidence
        result = self.read(directory / 'result.json') or {}
        recipe = self.read(directory / 'recipe.json') or {}
        asr = self.read(directory / 'asr/clip.json') or {}
        binding = self.read(directory / 'asr/evidence.json') or {}
        qa = self.read(directory / 'qa.json') or {}
        provider = asr.get('provider', {})
        media_hash, asr_hash = self.hash(directory / 'clip.mp4'), self.hash(directory / 'asr/clip.json')
        recipe_hash = audit.digest(recipe)
        checks = {
            'candidate_identity': result.get('candidate_id') == vid and recipe.get('candidate_id') == vid,
            'final_media_hash': bool(media_hash) and media_hash == result.get('output_sha256') == binding.get('media_sha256') == provider.get('input_sha256'),
            'asr_hash': bool(asr_hash) and asr_hash == binding.get('asr_sha256'),
            'persistent_small_en_cuda_float32': (provider.get('model') == 'small.en' and provider.get('device') == 'cuda'
                and provider.get('compute_type') == 'float32' and provider.get('requested_fp16') is False
                and provider.get('threads') == 8 and bool(provider.get('persistent_server', {}).get('session_id'))
                and provider.get('persistent_server', {}).get('independent_transcription_of_requested_media') is True),
            'unchanged_asr_inference_parameters': provider.get('beam_size') == 5 and provider.get('vad_filter') is False
                and provider.get('condition_on_previous_text') is False,
            'technical_qa': bool(qa.get('checks')) and all(v is True for v in qa.get('checks', {}).values()),
        }
        try:
            checks['word_timestamps'] = bool(luna.words_from(asr))
        except (ValueError, TypeError, KeyError):
            checks['word_timestamps'] = False
        if held_artifacts is not None:
            checks['handoff_hash_binding'] = (held_artifacts.get('media_sha256') == media_hash
                and held_artifacts.get('asr_sha256') == asr_hash and held_artifacts.get('recipe_hash') == recipe_hash)
        # Metadata-only copies legitimately retain ASR from byte-identical media.
        evidence.update(checked=True, checks=checks, media_sha256=media_hash, asr_sha256=asr_hash,
            recipe_hash=recipe_hash, provider=provider, byte_identical_metadata_copy=bool(result.get('metadata_only')),
            revision_attempt=result.get('attempt', 0), final_media=str(directory / 'clip.mp4'))
        if record.get('status') in {'published', 'already_published'}:
            receipt_path = self.path(record.get('publication_receipt') or f'publications/{vid}.json')
            receipt = self.read(receipt_path) or {}
            final_qa = self.read(directory / 'final-qa.json') or {}
            checks.update(publication_receipt=receipt.get('passed') is True and receipt.get('video_id') == vid
                and receipt.get('media_sha256') == media_hash and receipt.get('recipe_hash') == recipe_hash
                and bool(receipt.get('snippet_id')) and bool(receipt.get('gcs_generation')),
                final_qa=final_qa.get('passed') is True and final_qa.get('media_sha256') == media_hash
                    and final_qa.get('recipe_hash') == recipe_hash
                    and bool(final_qa.get('checks')) and all(v is True for v in final_qa.get('checks', {}).values())
                    and luna.release_gate_passed(final_qa.get('release_gate'), .95),
                published_size=bool((directory / 'clip.mp4').exists()) and receipt.get('uploaded_bytes') == (directory / 'clip.mp4').stat().st_size)
            evidence['publication'] = {'path': str(receipt_path), 'snippet_id': receipt.get('snippet_id'),
                'gcs_url': receipt.get('gcs_url'), 'gcs_generation': receipt.get('gcs_generation'),
                'query_jobs': receipt.get('query_jobs', []), 'live_readback_scope': 'Existing publication receipt only; no network readback in this report'}
        for name, passed in checks.items():
            if not passed:
                self.error('final_evidence_check_failed', directory, candidate_id=vid, check=name)
        return evidence

    def requests(self, slots):
        requests, responses, intervals, unknown, cancelled, revisions = [], {}, [], [], [], defaultdict(list)
        for slot in slots:
            group = self.root / 'batches' / slot['batch_name']
            for path in sorted(group.glob('*/request.json')):
                body = self.read(path) or {}
                packages = self.read(path.with_name('packages.json')) or []
                ids = [p.get('evidence', {}).get('candidate_id') for p in packages]
                digest = audit.digest(body)
                if digest != path.parent.name or not ids or len(ids) != len(set(ids)) or not set(ids).issubset(slot['candidate_ids']):
                    self.error('request_membership_or_hash_drift', path)
                raw = self.read(path.with_name('response.json'), optional=True) or {}
                state = self.read(path.with_name('call-state.json'), optional=True) or {}
                events = []
                event_path = path.with_name('transport-events.jsonl')
                if event_path.exists():
                    for number, line in enumerate(event_path.read_text(encoding='utf-8-sig').splitlines(), 1):
                        if not line.strip():
                            continue
                        try:
                            event = json.loads(line)
                            if event.get('request_hash') != digest or event.get('model') != body.get('model'):
                                self.error('transport_binding_drift', event_path, line=number)
                            events.append(event)
                        except (ValueError, AttributeError):
                            self.error('invalid_transport_event', event_path, line=number)
                starts = [e for e in events if e.get('event') == 'request_start']
                ends = [e for e in events if e.get('event') == 'request_end']
                unmatched = Counter((e.get('attempt'), e.get('pid')) for e in starts) != Counter((e.get('attempt'), e.get('pid')) for e in ends)
                for event in ends:
                    if event.get('status') == 'cancelled_before_dispatch':
                        if event.get('dispatched') is not False or event.get('charge_unknown') is not False:
                            self.error('unproven_transport_cancellation', event_path)
                        cancelled.append({'request_path': str(path), **event})
                        continue
                    if elapsed(event.get('started_at'), event.get('ended_at')) is None:
                        self.error('invalid_http_interval', event_path)
                    else:
                        intervals.append({**event, 'batch_name': slot['batch_name'], 'lane': slot['lane'], 'request_path': str(path)})
                rid, usage = raw.get('id'), raw.get('usage')
                if rid:
                    details = usage.get('input_tokens_details', {}) if isinstance(usage, dict) else {}
                    valid = isinstance(usage, dict) and isinstance(details, dict) and all(numeric(usage.get(k)) for k in ('input_tokens', 'output_tokens'))
                    valid = valid and all(numeric(details.get(k, 0)) for k in ('cached_tokens', 'cache_write_tokens'))
                    valid = valid and details.get('cached_tokens', 0) + details.get('cache_write_tokens', 0) <= usage['input_tokens']
                    if not valid or not str(raw.get('model', '')).startswith('gpt-6-luna') or raw.get('model') != body.get('model'):
                        self.error('invalid_response_model_or_usage', path.with_name('response.json'))
                    if rid in responses and responses[rid]['sha256'] != self.hash(path.with_name('response.json')):
                        self.error('conflicting_response_id', path, response_id=rid)
                    responses[rid] = {'response_id': rid, 'model': raw.get('model'), 'status': raw.get('status'), 'usage': usage,
                        'sha256': self.hash(path.with_name('response.json')), 'path': str(path.with_name('response.json')),
                        'lane': slot['lane'], 'role': state.get('role'), 'cost_usd': audit.price(raw) if valid else None}
                    if not any(e.get('response_id') == rid for e in ends):
                        self.error('response_missing_transport_receipt', path)
                safe_unsent = state.get('status') == 'cancelled_before_dispatch' and state.get('dispatched') is False and state.get('charge_unknown') is False
                is_unknown = any(e.get('status') == 'unknown_charge' for e in ends) or unmatched
                is_unknown |= bool(not rid and state and state.get('status') not in ('rejected', 'rate_limited') and not safe_unsent)
                if is_unknown:
                    unknown.append({'request_path': str(path), 'status': state.get('status'), 'unmatched_events': unmatched})
                requests.append({'request_hash': digest, 'path': str(path), 'batch_name': slot['batch_name'], 'lane': slot['lane'],
                    'candidate_ids': ids, 'response_id': rid, 'role': state.get('role'), 'state': state.get('status'),
                    'attempts': len(starts), 'http_attempts': sum(e.get('dispatched') is not False for e in ends),
                    'throttles': sum(e.get('http_status') == 429 for e in ends), 'unknown_charge': is_unknown})
            for path in sorted(group.glob('pipelines/*/ledger.json')):
                ledger = self.read(path) or {}
                for row in ledger.get('rounds', []):
                    if type(row.get('pass')) is not int or not 1 <= row['pass'] <= 5:
                        self.error('revision_exceeds_five_pass_budget', path)
                    for vid in row.get('active_candidates', []):
                        if vid not in slot['candidate_ids']:
                            self.error('revision_outside_frozen_group', path, candidate_id=vid)
                        revisions[vid].append({'pass': row.get('pass'), 'ledger_path': str(path)})
        return requests, responses, intervals, unknown, cancelled, revisions

    def trim_render_receipts(self, slots):
        """Count completed physical trims, not review passes or metadata copies."""
        renders, copies = defaultdict(dict), defaultdict(list)
        for slot in slots:
            for path in sorted((self.root / 'batches' / slot['batch_name'] / 'trimmed').glob('*/result.json')):
                result = self.read(path) or {}
                vid = result.get('candidate_id')
                if vid not in slot['candidate_ids']:
                    self.error('trim_receipt_outside_frozen_group', path, candidate_id=vid)
                    continue
                if result.get('metadata_only') is True:
                    copies[vid].append(str(path))
                    continue  # A copied trim.json/attempt/source pointer is not a render.
                if not (path.parent / 'trim.json').exists():
                    continue
                original = result.get('original_source_render_result')
                try:
                    render_path = self.path(original) if original else path.resolve()
                except ValueError:
                    self.error('trim_source_receipt_outside_run', path)
                    continue
                if original:
                    source = self.read(render_path) or {}
                    if source.get('candidate_id') != vid or source.get('output_sha256') != result.get('output_sha256'):
                        self.error('trim_original_source_receipt_drift', path)
                render = renders[vid].setdefault(render_path, {
                    'render_result_path': str(render_path),
                    'kind': 'original_source_trim' if original else 'encoded_parent_trim',
                    'output_sha256': result.get('output_sha256'), 'trim_receipt_paths': []})
                if render['output_sha256'] != result.get('output_sha256'):
                    self.error('conflicting_physical_trim_receipts', path)
                render['trim_receipt_paths'].append(str(path))
        return {vid: list(items.values()) for vid, items in renders.items()}, copies

    def run(self):
        plan_path = self.root / 'stream-plan.json'
        plan, status = self.read(plan_path) or {}, self.read(self.root / 'stream-status.json', optional=True) or {}
        ids, slots = plan.get('candidate_ids', []), plan.get('slots', [])
        count = plan.get('target_candidate_count')
        if self.expected_id and plan.get('stream_id') != self.expected_id:
            self.error('stream_identity_mismatch', plan_path)
        if status and status.get('stream_id') != plan.get('stream_id'):
            self.error('stream_status_identity_mismatch')
        if audit.digest({k: v for k, v in plan.items() if k != 'plan_sha256'}) != plan.get('plan_sha256'):
            self.error('stream_plan_hash_drift', plan_path)
        flat = [vid for slot in slots for vid in slot.get('candidate_ids', [])]
        if type(count) is not int or not 1 <= count <= 5 or len(ids) != count or len(set(ids)) != len(ids) or ids != flat:
            self.error('invalid_frozen_tiny_membership', plan_path)
        if (len({s.get('batch_name') for s in slots}) != len(slots) or any(not re.fullmatch(r'[A-Za-z0-9_-]+', s.get('batch_name', '')) for s in slots)):
            self.error('invalid_or_duplicate_batch_name', plan_path)
            slots = []  # Do not follow unsafe receipt paths.
        manifest_path = self.root / 'input/manifest.json'
        manifest = self.read(manifest_path) or {}
        wanted = {r.get('candidate_id'): r for r in manifest.get('candidates', [])}
        if self.hash(manifest_path) != plan.get('manifest_sha256'):
            self.error('manifest_hash_drift', manifest_path)
        for slot in slots:
            if (slot.get('items') != [wanted.get(vid) for vid in slot['candidate_ids']] or
                    any(wanted.get(vid, {}).get('lane') != slot.get('lane') for vid in slot['candidate_ids'])):
                self.error('stream_slot_manifest_drift', plan_path)
        if count == 5 and Counter(s.get('lane') for s in slots) != Counter({'eligible': 1, 'review': 1}):
            self.error('tiny_mixed_lane_slots_missing')
        lane_ids = {vid: slot['lane'] for slot in slots for vid in slot['candidate_ids']}
        if count == 5 and Counter(lane_ids.values()) != Counter({'eligible': 3, 'review': 2}):
            self.error('tiny_mixed_lane_membership_not_three_plus_two')
        excluded, baseline = set(plan.get('excluded_prior_candidate_ids', [])), plan.get('baseline_record_sha256', {})
        old = self.read(self.root / 'experiment-plan.json', optional=True) or {}
        if set(ids) & (excluded | set(baseline) | set(old.get('candidate_ids', []))) or not set(baseline).issubset(excluded):
            self.error('tiny_membership_overlaps_prior_work')
        if not set(old.get('candidate_ids', [])).issubset(excluded):
            self.error('old_fifty_not_fully_excluded')
        records, overrun = {}, []
        for path in sorted((self.root / 'records').glob('*.json')):
            record = self.read(path) or {}
            vid = record.get('candidate_id')
            if vid != path.stem or vid in records:
                self.error('duplicate_or_misnamed_record', path)
            records[vid] = record
            if vid in baseline:
                if self.hash(path) != baseline[vid]:
                    self.error('baseline_record_changed', path)
            elif vid not in ids:
                overrun.append(vid)
                self.error('record_outside_tiny_admission', path)
        for vid in set(baseline) - set(records):
            self.error('baseline_record_missing', candidate_id=vid)
        stages = self.stage_events(set(ids), status.get('started_at') or plan.get('created_at'))
        requests, responses, intervals, unknown, cancelled, revisions = self.requests(slots)
        trim_renders, metadata_copies = self.trim_render_receipts(slots)
        coverage = []
        for vid in ids:
            record = records.get(vid, {})
            state = record.get('status', 'pending')
            outcome = 'published' if state in ('published', 'already_published') else 'held' if state == 'awaiting_astra' else 'failed' if state in FAILED else 'pending'
            try:
                evidence = self.final_evidence(vid, record)
            except (ValueError, OSError, TypeError, KeyError) as exc:
                self.error('final_evidence_unreadable', candidate_id=vid, error_type=type(exc).__name__)
                evidence = {'checked': False}
            times = {}
            for event in stages.get(vid, []):
                times.setdefault(event['stage'], event['time'])
            coverage.append({'candidate_id': vid, 'lane': lane_ids.get(vid), 'status': state, 'outcome': outcome,
                'attempted': bool(record), 'stage': record.get('stage'), 'reason': record.get('reason') or record.get('error'),
                'failure_category': ('source_failed' if record.get('isolated_source_failure') or
                                     SOURCE_ERROR.search(str(record.get('error', ''))) else 'other_failed') if outcome == 'failed' else None,
                'stage_events': stages.get(vid, []), 'stage_times': times,
                'preparation_wall_seconds': elapsed(times.get('preparing'), times.get('prepared')),
                'review_to_disposition_seconds': elapsed(times.get('reviewing'), record.get('updated_at')),
                'review_passes': revisions.get(vid, []), 'review_pass_count': len(revisions.get(vid, [])),
                'physical_trim_renders': trim_renders.get(vid, []),
                'physical_trim_render_count': len(trim_renders.get(vid, [])),
                'source_trim_render_count': sum(r['kind'] == 'original_source_trim' for r in trim_renders.get(vid, [])),
                'metadata_only_copy_count': len(metadata_copies.get(vid, [])),
                'metadata_only_copy_receipts': metadata_copies.get(vid, []), 'final_evidence': evidence})
        witnesses = []
        for interval in intervals:
            for row in coverage:
                if row['lane'] == interval['lane']:
                    continue
                times = row['stage_times']
                a, b = timestamp(times.get('preparing')), timestamp(times.get('prepared'))
                x, y = timestamp(interval.get('started_at')), timestamp(interval.get('ended_at'))
                if None not in (a, b, x, y) and min(b, y) > max(a, x):
                    witnesses.append({'review_batch': interval['batch_name'], 'request_hash': interval['request_hash'],
                        'actual_http_started_at': interval['started_at'], 'preparing_candidate': row['candidate_id'],
                        'preparation_started_at': times['preparing'], 'preparation_finished_at': times['prepared'],
                        'review_started_while_other_preparing': a <= x < b, 'overlap_seconds': min(b, y) - max(a, x)})
        counts = Counter(row['outcome'] for row in coverage)
        tokens = Counter()
        for response in responses.values():
            if isinstance(response.get('usage'), dict):
                tokens.update(flattened_numbers(response['usage']))
        checks = {'tiny_receipt_integrity': not self.errors, 'all_selected_disposed': len(coverage) == count and not counts['pending'],
                  'no_unknown_current_trial_charges': not unknown, 'trial_finished': status.get('phase') == 'stream_completed' and bool(status.get('finished_at'))}
        report = {'schema_version': 'snippy-tiny-validation-report-v1', 'generated_at': audit.now(),
            'stream_id': plan.get('stream_id'), 'plan_sha256': plan.get('plan_sha256'), 'selected_ids': ids,
            'baseline_record_count': len(baseline), 'excluded_prior_count': len(excluded),
            'scope': 'Only the frozen tiny trial; old queue completion and prior unknown charges are outside this verdict.',
            'phase': status.get('phase'), 'counts': {k: counts[k] for k in ('published', 'held', 'failed', 'pending')},
            'attempted': sum(r['attempted'] for r in coverage), 'pending_ids': [r['candidate_id'] for r in coverage if r['outcome'] == 'pending'],
            'overrun_ids': overrun, 'coverage': coverage, 'checks': checks, 'errors': self.errors,
            'work_counts': {'review_passes': sum(r['review_pass_count'] for r in coverage),
                'physical_trim_renders': sum(r['physical_trim_render_count'] for r in coverage),
                'source_trim_renders': sum(r['source_trim_render_count'] for r in coverage),
                'metadata_only_copies': sum(r['metadata_only_copy_count'] for r in coverage),
                'definition': 'Review passes count Luna ledger rounds per candidate. Physical source trims are deduplicated by original_source_render_result. Metadata-only copies and nested duplicate render receipts do not add physical renders.'},
            'passed': all(checks.values()), 'all_selected_published': counts['published'] == count,
            'timing': {'started_at': status.get('started_at'), 'finished_at': status.get('finished_at'),
                'total_wall_seconds': elapsed(status.get('started_at'), status.get('finished_at')), 'attempts': status.get('attempts', [])},
            'streaming_overlap': {'observed': bool(witnesses), 'witnesses': witnesses,
                'measurement': 'Actual closed HTTP intervals against another lane candidate preparing-to-prepared stage logs; no inferred steady-state throughput.'},
            'transport': {**overlap(intervals), 'intervals': intervals, 'unknown_charge_calls': unknown,
                'cancelled_before_dispatch': cancelled, 'attempts': sum(r['attempts'] for r in requests), 'throttles_429': sum(r['throttles'] for r in requests)},
            'api': {'requests': requests, 'responses': list(responses.values()), 'response_ids': sorted(responses),
                'token_categories': dict(tokens), 'usage_derived_cost_usd': sum(r['cost_usd'] or 0 for r in responses.values()),
                'pricing_basis': 'Unchanged audit.price on unique saved response usage; estimate, not invoice; unknown charges excluded.'},
            'lanes': {lane: {'counts': dict(Counter(r['outcome'] for r in coverage if r['lane'] == lane)),
                'candidate_ids': [r['candidate_id'] for r in coverage if r['lane'] == lane],
                'usage_derived_cost_usd': sum(r['cost_usd'] or 0 for r in responses.values() if r['lane'] == lane),
                'http': overlap([r for r in intervals if r['lane'] == lane])} for lane in sorted(set(lane_ids.values()))},
            'stop_contract': 'STOP after this frozen tiny trial. No restart of the old wave and no further admission without authorization.'}
        audit.atomic(self.root / 'tiny-validation-report.json', report)
        self.markdown(report)
        return report

    def markdown(self, report):
        lines = [f"# Tiny validation: {report['stream_id']}", '',
            f"Receipt verification: **{'PASS' if report['passed'] else 'INCOMPLETE / FLAGGED'}**. Outcomes: {report['counts']}.",
            f"Trial wall: {report['timing']['total_wall_seconds']} seconds. Luna usage-derived cost: ${report['api']['usage_derived_cost_usd']:.9f}; not an invoice.",
            f"Measured review/preparation overlap: {report['streaming_overlap']['observed']}. Prior baseline records checked: {report['baseline_record_count']}.", '',
            f"Review passes: {report['work_counts']['review_passes']}; physical source-trim renders: {report['work_counts']['source_trim_renders']}; metadata-only copies: {report['work_counts']['metadata_only_copies']}.", '',
            '| Candidate | Lane | Outcome | Review passes | Physical trims | Metadata copies | Final evidence |', '|---|---|---|---:|---:|---:|---|']
        for row in report['coverage']:
            evidence = row['final_evidence']
            verdict = 'PASS' if evidence.get('checked') and all(evidence.get('checks', {}).values()) else 'Required / missing' if evidence.get('required') else 'Not reached'
            lines.append(f"| {row['candidate_id']} | {row['lane']} | {row['status']} | {row['review_pass_count']} | {row['physical_trim_render_count']} | {row['metadata_only_copy_count']} | {verdict} |")
        lines += ['', *[f"- {key}: {'PASS' if value else 'FAIL'}" for key, value in report['checks'].items()]]
        if report['errors']:
            lines += ['', *[f"- {error['code']}: {error.get('candidate_id') or error.get('path', '')}" for error in report['errors']]]
        lines += ['', report['scope'], '', report['stop_contract'], '', 'Full receipt details: [tiny-validation-report.json](tiny-validation-report.json).', '']
        (self.root / 'tiny-validation-report.md').write_text('\n'.join(lines), encoding='utf-8')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--stream-id')
    args = parser.parse_args(argv)
    report = TinyReporter(args.root, args.stream_id).run()
    print(json.dumps({'report': str(args.root / 'tiny-validation-report.json'), 'passed': report['passed'],
                      'counts': report['counts'], 'errors': len(report['errors'])}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
