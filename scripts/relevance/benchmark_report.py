#!/usr/bin/env python3
"""Offline receipt report for the frozen ten-groups-of-five experiment.

Does not run production, invoke reviewers, publish, or retry calls. Even a failed
verification writes benchmark-report.json and benchmark-report.md for diagnosis.
"""
import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path

import audit
from production_report import flattened_numbers, numeric, sha

FINAL_STATUSES = {'published', 'already_published', 'awaiting_astra', 'failed', 'source_failed', 'other_failed'}


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.timestamp() if result.tzinfo else None
    except ValueError:
        return None


def elapsed(start, end):
    a, b = timestamp(start), timestamp(end)
    return round(b - a, 6) if a is not None and b is not None and b >= a else None


def overlap(intervals):
    """Maximum proven concurrency from closed request intervals [start, end)."""
    points, spans = [], []
    for row in intervals:
        a, b = timestamp(row['started_at']), timestamp(row['ended_at'])
        if a is not None and b is not None and b > a:
            points.extend([(a, 1, row['started_at']), (b, -1, row['ended_at'])])
            spans.append((a, b))
    active = peak = 0
    peaks = []
    for _, change, text in sorted(points, key=lambda p: (p[0], p[1])):
        active += change
        if active > peak:
            peak, peaks = active, [text]
        elif change == 1 and active == peak:
            peaks.append(text)
    union, last_end = 0.0, None
    for a, b in sorted(spans):
        union += max(0, b - max(a, last_end if last_end is not None else a))
        last_end = max(b, last_end if last_end is not None else b)
    return {'peak_overlapping_requests': peak, 'peak_timestamps': peaks[:50],
            'summed_http_call_seconds': round(sum(b-a for a, b in spans), 6),
            'union_http_call_seconds': round(union, 6),
            'observed_http_span_seconds': round(max(b for _, b in spans) - min(a for a, _ in spans), 6) if spans else None,
            'closed_intervals': len(intervals), 'interval_convention': '[started_at, ended_at); equal-time ends precede starts'}


class BenchmarkReporter:
    def __init__(self, root, experiment_id=None, claim_at=None):
        self.root, self.expected_id = Path(root).resolve(), experiment_id
        self.claim_at = claim_at
        self.errors = []

    def error(self, code, path=None, **detail):
        self.errors.append({'code': code, **({'path': str(path)} if path else {}), **detail})

    def read(self, path, optional=False):
        path = Path(path)
        if optional and not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding='utf-8-sig'))
        except (ValueError, OSError) as exc:
            self.error('missing_or_invalid_receipt', path, error_type=type(exc).__name__)
            return None

    def plan(self):
        path = self.root / 'experiment-plan.json'
        plan = self.read(path) or {}
        ids, slots = plan.get('candidate_ids', []), plan.get('slots', [])
        if self.expected_id and plan.get('experiment_id') != self.expected_id:
            self.error('experiment_id_mismatch', path)
        if plan.get('target_batch_count') != 10 or plan.get('target_candidate_count') != 50:
            self.error('experiment_target_not_ten_by_five', path)
        flattened = [vid for slot in slots for vid in slot.get('candidate_ids', [])]
        if len(ids) != 50 or len(set(ids)) != 50 or len(slots) != 10 or len(set(flattened)) != 50 or set(ids) != set(flattened) or any(len(s.get('candidate_ids', [])) != 5 for s in slots):
            self.error('frozen_fifty_membership_invalid', path)
        if len({s.get('batch_name') for s in slots}) != len(slots):
            self.error('duplicate_experiment_group', path)
        baseline = set(plan.get('baseline_covered_ids', []))
        if len(baseline) < 25 or len(baseline) != len(plan.get('baseline_covered_ids', [])) or baseline.intersection(ids):
            self.error('signed_baseline_not_isolated', path)
        manifest = self.root / 'input/manifest.json'
        if not manifest.exists() or sha(manifest) != plan.get('manifest_sha256'):
            self.error('manifest_hash_drift', manifest)
        manifest_data = self.read(manifest) or {}
        manifest_lanes = {r.get('candidate_id'): r.get('lane') for r in manifest_data.get('candidates', [])}
        if not set(ids).issubset(manifest_lanes):
            self.error('frozen_candidates_outside_manifest', path)
        if any(manifest_lanes.get(vid) != slot.get('lane') for slot in slots for vid in slot.get('candidate_ids', [])):
            self.error('frozen_group_lane_mismatch', path)
        if plan.get('plan_sha256'):
            unsigned = {k: v for k, v in plan.items() if k != 'plan_sha256'}
            if audit.digest(unsigned) != plan['plan_sha256']:
                self.error('experiment_plan_signature_drift', path)
        else:
            self.error('experiment_plan_signature_missing', path)
        return plan

    def raw_responses(self):
        rows = {}
        for base in (self.root / 'batches', self.root / 'mac-checkpoint/batches'):
            for path in sorted(base.glob('*/*/response.json')):
                raw = self.read(path)
                if not isinstance(raw, dict) or not raw.get('id'):
                    self.error('response_id_missing', path)
                    continue
                rid = raw['id']
                if rid in rows:
                    if rows[rid]['response_sha256'] != audit.digest(raw):
                        self.error('conflicting_response_id', path, response_id=rid)
                    rows[rid]['paths'].append(str(path))
                    continue
                usage = raw.get('usage')
                detail = usage.get('input_tokens_details', {}) if isinstance(usage, dict) else {}
                valid = isinstance(usage, dict) and isinstance(detail, dict) and all(numeric(usage.get(k)) for k in ('input_tokens', 'output_tokens')) and all(numeric(detail.get(k, 0)) for k in ('cached_tokens', 'cache_write_tokens'))
                if valid:
                    valid = detail.get('cached_tokens', 0) + detail.get('cache_write_tokens', 0) <= usage['input_tokens']
                luna = str(raw.get('model', '')).startswith('gpt-6-luna')
                if not valid or not luna:
                    self.error('unpriced_or_unexpected_response', path, response_id=rid, model=raw.get('model'))
                rows[rid] = {'response_id': rid, 'model': raw.get('model'), 'usage': usage,
                    'usage_derived_cost_usd': audit.price(raw) if valid and luna else None,
                    'response_sha256': audit.digest(raw), 'paths': [str(path)]}
        return rows

    def transport(self, path):
        if not path.exists():
            return []
        events = []
        with path.open(encoding='utf-8-sig') as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise ValueError('event is not an object')
                    events.append(event)
                except ValueError:
                    self.error('invalid_transport_event', path, line=line_number)
        return events

    def run(self):
        plan = self.plan()
        selected = set(plan.get('candidate_ids', []))
        candidate_lanes = {vid: slot.get('lane', 'unknown') for slot in plan.get('slots', []) for vid in slot.get('candidate_ids', [])}
        group_lanes = {slot['batch_name']: slot.get('lane', 'unknown') for slot in plan.get('slots', [])}
        baseline = set(plan.get('baseline_covered_ids', []))
        status = self.read(self.root / 'experiment-status.json', optional=True) or {}
        if status and status.get('experiment_id') != plan.get('experiment_id'):
            self.error('experiment_status_identity_mismatch', self.root / 'experiment-status.json')
        frozen_hashes = plan.get('baseline_record_sha256', {})
        if set(frozen_hashes) != baseline:
            self.error('baseline_record_hash_inventory_missing', self.root / 'experiment-plan.json')
        coverage, seen, overrun = [], {}, []
        for path in sorted((self.root / 'records').glob('*.json')):
            row = self.read(path)
            if not isinstance(row, dict):
                continue
            vid = row.get('candidate_id')
            if vid in seen or vid != path.stem:
                self.error('duplicate_or_misnamed_record', path, candidate_id=vid)
            seen[vid] = row
            if vid in baseline:
                if sha(path) != frozen_hashes.get(vid):
                    self.error('baseline_record_changed', path, candidate_id=vid)
            elif vid not in selected:
                overrun.append(vid)
                self.error('candidate_outside_authorized_fifty', path, candidate_id=vid)
        for vid in sorted(baseline - set(seen)):
            self.error('baseline_record_missing', candidate_id=vid)
        for vid in plan.get('candidate_ids', []):
            row = seen.get(vid, {})
            state = row.get('status', 'pending')
            outcome = ('pass' if state in ('published', 'already_published') else 'deferred' if state == 'awaiting_astra'
                       else 'failed' if state in ('failed', 'source_failed', 'other_failed') else 'pending')
            coverage.append({'candidate_id': vid, 'lane': candidate_lanes.get(vid), 'status': state, 'outcome': outcome,
                'attempted': bool(row), 'stage': row.get('stage'), 'reason': row.get('reason') or row.get('error'),
                'updated_at': row.get('updated_at'),
                'evidence': {k: row[k] for k in ('publication_receipt', 'final_directory', 'directory', 'handoff', 'batch') if row.get(k)}})
        raw = self.raw_responses()
        requests, intervals, starts, ends, unknown, request_ids, event_count = [], [], [], [], [], set(), 0
        group_stats = []
        for slot in plan.get('slots', []):
            group = self.root / 'batches' / slot['batch_name']
            members = set(slot['candidate_ids'])
            group_response_ids, group_starts, group_ends, group_http_starts = set(), [], [], []
            for request_path in sorted(group.glob('*/request.json')):
                body = self.read(request_path)
                if not isinstance(body, dict):
                    continue
                request_hash = audit.digest(body)
                if request_hash != request_path.parent.name:
                    self.error('request_hash_drift', request_path)
                packages = self.read(request_path.with_name('packages.json'))
                package_ids = [p.get('evidence', {}).get('candidate_id') for p in packages] if isinstance(packages, list) else []
                if not package_ids or len(set(package_ids)) != len(package_ids) or not set(package_ids).issubset(members):
                    self.error('request_outside_frozen_group', request_path, candidate_ids=package_ids)
                response = self.read(request_path.with_name('response.json'), optional=True)
                rid = response.get('id') if isinstance(response, dict) else None
                if rid:
                    request_ids.add(rid); group_response_ids.add(rid)
                    if body.get('model') != response.get('model'):
                        self.error('request_response_model_mismatch', request_path)
                state = self.read(request_path.with_name('call-state.json'), optional=True) or {}
                events = self.transport(request_path.with_name('transport-events.jsonl'))
                event_count += len(events)
                request_starts, request_ends = [], []
                for event in events:
                    if event.get('request_hash') != request_hash or event.get('model') != body.get('model'):
                        self.error('transport_request_binding_drift', request_path)
                    entry = {**event, 'batch_name': slot['batch_name'], 'request_path': str(request_path)}
                    if event.get('event') == 'request_start':
                        request_starts.append(entry); starts.append(entry); group_starts.append(entry.get('started_at') or entry.get('timestamp'))
                    elif event.get('event') == 'request_end':
                        request_ends.append(entry); ends.append(entry); group_ends.append(entry.get('ended_at') or entry.get('timestamp'))
                        if (event.get('status') == 'cancelled_before_dispatch' and event.get('dispatched') is False
                                and event.get('charge_unknown') is False):
                            continue
                        a, b = entry.get('started_at'), entry.get('ended_at') or entry.get('timestamp')
                        group_http_starts.append(a)
                        duration = elapsed(a, b)
                        if duration is None:
                            self.error('invalid_request_interval', request_path)
                        else:
                            intervals.append({'batch_name': slot['batch_name'], 'request_hash': request_hash,
                                'role': event.get('role'), 'model': event.get('model'), 'attempt': event.get('attempt'),
                                'started_at': a, 'ended_at': b, 'elapsed_seconds': duration,
                                'http_status': event.get('http_status'), 'response_id': event.get('response_id'),
                                'status': event.get('status'), 'error_type': event.get('error_type')})
                # Dispatch intent is fsynced before the precise pre-POST start.
                # Match by attempt/process, then measure only the end receipt's
                # actual HTTP endpoints; the two start timestamps may differ.
                start_keys = Counter((e.get('attempt'), e.get('pid')) for e in request_starts)
                end_keys = Counter((e.get('attempt'), e.get('pid')) for e in request_ends)
                unmatched = start_keys != end_keys
                unknown_attempts = [e.get('attempt') for e in request_ends if e.get('status') == 'unknown_charge']
                cancelled_unsent = (state.get('status') == 'cancelled_before_dispatch' and state.get('dispatched') is False
                                    and state.get('charge_unknown') is False)
                unknown_charge = bool(unknown_attempts) or (not rid and state.get('status') not in ('rejected', 'rate_limited') and not cancelled_unsent)
                if unknown_charge or unmatched:
                    unknown.append({'batch_name': slot['batch_name'], 'request_hash': request_hash,
                        'call_status': state.get('status'), 'charge_unknown': unknown_charge,
                        'unknown_charge_attempts': unknown_attempts,
                        'unmatched_transport_events': unmatched, 'request_path': str(request_path)})
                if rid and not events:
                    self.error('benchmark_response_missing_transport_receipt', request_path)
                requests.append({'batch_name': slot['batch_name'], 'request_hash': request_hash,
                    'request_path': str(request_path), 'candidate_ids': package_ids, 'model': body.get('model'),
                    'role': state.get('role') or next((e.get('role') for e in events if e.get('role')), None),
                    'response_id': rid, 'call_status': state.get('status'),
                    'transport_attempts_started': len(request_starts), 'transport_attempts_finished': len(request_ends),
                    'usage': response.get('usage') if isinstance(response, dict) else None,
                    'usage_derived_cost_usd': raw.get(rid, {}).get('usage_derived_cost_usd')})
            group_stats.append({'batch_name': slot['batch_name'], 'lane': slot.get('lane'), 'candidate_ids': slot['candidate_ids'],
                'response_ids': sorted(group_response_ids),
                'first_request_dispatch_intent': min((t for t in group_starts if timestamp(t) is not None), default=None),
                'first_request_start': min((t for t in group_http_starts if timestamp(t) is not None), default=None),
                'last_request_end': max((t for t in group_ends if timestamp(t) is not None), default=None)})
        baseline_response_ids = set(plan.get('baseline_response_ids', []))
        if not baseline_response_ids:
            self.error('baseline_response_inventory_missing', self.root / 'experiment-plan.json')
        unexplained = set(raw) - request_ids - baseline_response_ids
        if unexplained:
            self.error('api_responses_outside_authorized_experiment', response_ids=sorted(unexplained))
        if baseline_response_ids - set(raw):
            self.error('baseline_response_receipts_missing', response_ids=sorted(baseline_response_ids - set(raw)))
        authorized_groups = {slot['batch_name'] for slot in plan.get('slots', [])}
        baseline_request_paths = set(plan.get('baseline_request_paths', []))
        baseline_request_hashes = plan.get('baseline_request_sha256', {})
        for relative in baseline_request_paths:
            path = (self.root / relative).resolve()
            if not path.is_relative_to(self.root) or Path(relative).is_absolute() or path.name != 'request.json':
                self.error('invalid_frozen_baseline_request_path', relative)
                continue
            body = self.read(path)
            if body is not None and audit.digest(body) != path.parent.name:
                self.error('baseline_request_hash_drift', path)
            if baseline_request_hashes and (not path.exists() or sha(path) != baseline_request_hashes.get(relative)):
                self.error('signed_baseline_request_file_hash_drift', path)
        unauthorized_requests = []
        for path in sorted((self.root / 'batches').glob('*/*/request.json')):
            if path.parent.parent.name in authorized_groups:
                continue
            if path.relative_to(self.root).as_posix() in baseline_request_paths:
                continue
            response = self.read(path.with_name('response.json'), optional=True) or {}
            if response.get('id') not in baseline_response_ids:
                unauthorized_requests.append(str(path))
                self.error('request_outside_authorized_experiment', path)
        responses = [raw[rid] for rid in sorted(request_ids) if rid in raw]
        tokens = Counter()
        for row in responses:
            if isinstance(row.get('usage'), dict):
                tokens.update(flattened_numbers(row['usage']))
        cost = sum(r['usage_derived_cost_usd'] or 0 for r in responses)
        baseline_cost = sum(raw[rid]['usage_derived_cost_usd'] or 0 for rid in baseline_response_ids if rid in raw)
        mac_ids = {rid for rid, row in raw.items() if any('/mac-checkpoint/' in p.replace('\\', '/') for p in row['paths'])}
        mac_cost = sum(raw[rid]['usage_derived_cost_usd'] or 0 for rid in mac_ids & baseline_response_ids)
        initial_ids = baseline_response_ids
        previous_plan, previous_status, preserved_unknown = {}, {}, []
        previous_id = plan.get('previous_experiment_id')
        if previous_id:
            archive = self.root / 'experiments' / previous_id
            previous_plan = self.read(archive / 'artifacts/experiment-plan.json') or {}
            previous_status = self.read(archive / 'artifacts/experiment-status.json') or {}
            archive_manifest = self.read(archive / 'archive-manifest.json') or {}
            preserved_unknown = archive_manifest.get('first_wave_unknown_charge_evidence_preserved', [])
            signed_unknown = plan.get('preserved_first_wave_unknown_charges')
            if signed_unknown is not None:
                if signed_unknown != preserved_unknown:
                    self.error('preserved_unknown_archive_binding_drift', archive)
                preserved_unknown = signed_unknown
            previous_digest = audit.digest({k: v for k, v in previous_plan.items() if k != 'plan_sha256'})
            if previous_digest != previous_plan.get('plan_sha256') or previous_digest != plan.get('previous_plan_sha256'):
                self.error('previous_experiment_plan_binding_drift', archive)
            initial_ids = set(previous_plan.get('baseline_response_ids', []))
            if not initial_ids or not initial_ids.issubset(baseline_response_ids):
                self.error('initial_baseline_response_inventory_missing', archive)
        initial_shadow_cost = sum(raw[rid]['usage_derived_cost_usd'] or 0 for rid in (initial_ids - mac_ids) if rid in raw)
        previous_experiment_cost = sum(raw[rid]['usage_derived_cost_usd'] or 0 for rid in (baseline_response_ids - initial_ids) if rid in raw)
        for field, derived in [('initial_shadow_cost_usd', initial_shadow_cost), ('previous_experiment_cost_usd', previous_experiment_cost)]:
            if field in plan and (not numeric(plan[field]) or abs(plan[field] - derived) > 1e-10):
                self.error('signed_baseline_cost_component_drift', component=field, usage_derived=derived)
        inherited_unknown_count = plan.get('preserved_unknown_charge_count', 0)
        if not isinstance(inherited_unknown_count, int) or inherited_unknown_count < 0 or inherited_unknown_count != len(preserved_unknown):
            self.error('preserved_unknown_charge_inventory_mismatch', declared=inherited_unknown_count, observed=len(preserved_unknown))
        if numeric(plan.get('baseline_luna_cost_usd')) and abs(baseline_cost - plan['baseline_luna_cost_usd']) > 1e-10:
            self.error('baseline_cost_receipts_drift', expected=plan['baseline_luna_cost_usd'], usage_derived=baseline_cost)
        transfers = {}
        for path in sorted((self.root / 'rendered').glob('*/transfer.json')):
            if path.parent.name[:11] not in selected:
                continue
            data = self.read(path)
            if isinstance(data, dict):
                bounds = [data.get(k) for k in ('upstream_body_bytes_read', 'conservative_response_bytes_upper_bound', 'upstream_requested_bytes')]
                if not all(numeric(v) for v in bounds) or not bounds[0] <= bounds[1] <= bounds[2]:
                    self.error('invalid_gcs_transfer_bounds', path)
                key = audit.digest(data)
                transfers.setdefault(key, {'candidate_id': path.parent.name[:11], 'paths': [],
                    **{k: data.get(k) for k in ('upstream_body_bytes_read', 'upstream_requested_bytes', 'conservative_response_bytes_upper_bound')},
                    'errors': data.get('errors', [])})['paths'].append(str(path))
        transfer_totals = {key: sum(r[key] for r in transfers.values() if numeric(r.get(key))) for key in
            ('upstream_body_bytes_read', 'upstream_requested_bytes', 'conservative_response_bytes_upper_bound')}
        counts = Counter(r['outcome'] for r in coverage)
        timing = {key: status.get(key) for key in ('started_at', 'preparation_started_at', 'preparation_finished_at',
            'review_started_at', 'review_finished_at', 'finished_at')}
        timing.update(total_wall_seconds=elapsed(timing['started_at'], timing['finished_at']),
            preparation_wall_seconds=elapsed(timing['preparation_started_at'], timing['preparation_finished_at']),
            review_repair_publication_phase_seconds=elapsed(timing['review_started_at'], timing['review_finished_at']),
            attempts=status.get('attempts', []))
        context = self.read(self.root / 'benchmark-context.json', optional=True) or {}
        cancelled_second = context.get('second_wave_cancelled') is True
        two_waves = (not cancelled_second and context.get('authorized_wave_count') == 2 and
                     context.get('authorized_total_fresh_candidates') == 100)
        wave_number = 2 if previous_id else 1
        stop_contract = (
            'Report and preserve this first wave before the authorized second bounded 50 candidates. '
            'STOP after wave 2 (100 fresh candidates total) for cost/time confirmation before any more production; '
            'no Astra work authorized.'
            if two_waves and wave_number == 1 else
            'STOP after this bounded experiment. Cost/time confirmation required before any more production; '
            'no Astra work authorized.')
        if cancelled_second:
            stop_contract = ('Large wave paused incomplete by user override; second 50-candidate wave CANCELLED. '
                             'Only tiny optimization experiments and at most five fresh validation candidates are authorized; '
                             'stop afterward for cost/time review. No Astra editorial work.')
        claimed_at = self.claim_at or context.get('relay_claimed_at') or plan.get('relay_claimed_at')
        initial_trial_start = previous_status.get('started_at') or timing['started_at']
        setup = {'relay_claimed_at': claimed_at, 'trial_started_at': initial_trial_start,
            'current_trial_started_at': timing['started_at'],
            'setup_before_trial_seconds': elapsed(claimed_at, initial_trial_start),
            'interwave_gap_seconds': elapsed(previous_status.get('finished_at'), timing['started_at']),
            'scope': 'One-time claim-to-trial setup; excluded from trial and steady-phase throughput.'}
        timing['measured_throughput'] = {}
        for name, seconds in [('end_to_end', timing['total_wall_seconds']), ('review_repair_publication', timing['review_repair_publication_phase_seconds'])]:
            timing['measured_throughput'][name] = {
                'published_clips_per_hour': counts['pass'] * 3600 / seconds if seconds else None,
                'disposed_candidates_per_hour': (50 - counts['pending']) * 3600 / seconds if seconds else None}
        lanes = {}
        for lane in sorted(set(candidate_lanes.values())):
            lane_rows = [r for r in coverage if r['lane'] == lane]
            lane_counts = Counter(r['outcome'] for r in lane_rows)
            lane_groups = [g for g in group_stats if g['lane'] == lane]
            lane_ids = {rid for g in lane_groups for rid in g['response_ids']}
            lane_responses = [raw[rid] for rid in sorted(lane_ids) if rid in raw]
            lane_tokens = Counter()
            for row in lane_responses:
                if isinstance(row.get('usage'), dict):
                    lane_tokens.update(flattened_numbers(row['usage']))
            lane_intervals = [r for r in intervals if group_lanes.get(r['batch_name']) == lane]
            lane_transfers = [r for r in transfers.values() if candidate_lanes.get(r['candidate_id']) == lane]
            lane_starts = [r['started_at'] for r in lane_intervals if timestamp(r['started_at']) is not None]
            dispositions_at = [r['updated_at'] for r in lane_rows if r['outcome'] != 'pending' and timestamp(r.get('updated_at')) is not None]
            first_start = min(lane_starts, key=timestamp) if lane_starts else None
            final_disposition = max(dispositions_at, key=timestamp) if dispositions_at else None
            lanes[lane] = {'groups': len(lane_groups), 'candidates': len(lane_rows),
                'counts': {'attempted': sum(r['attempted'] for r in lane_rows), 'pass': lane_counts['pass'],
                    'deferred': lane_counts['deferred'], 'failed': lane_counts['failed'], 'pending': lane_counts['pending']},
                'response_ids': sorted(lane_ids), 'usage_derived_cost_usd': sum(r['usage_derived_cost_usd'] or 0 for r in lane_responses),
                'token_categories': dict(lane_tokens), 'http': overlap(lane_intervals),
                'first_http_start': first_start, 'last_recorded_disposition_at': final_disposition,
                'observed_review_to_disposition_span_seconds': elapsed(first_start, final_disposition),
                'timing_scope': 'Observed lane HTTP intervals and record dispositions; no independent per-lane preparation timer recorded.',
                'gcs': {k: sum(r[k] for r in lane_transfers if numeric(r.get(k))) for k in transfer_totals}}
        checks = {'integrity': not self.errors, 'exact_fifty_coverage': len(coverage) == len(selected) == 50,
            'all_fifty_disposed': len(coverage) == 50 and counts['pending'] == 0,
            'no_overrun': not overrun and not unexplained and not unauthorized_requests,
            'current_wave_unknown_charges_and_transport_resolved': not unknown,
            'preserved_baseline_unknowns_resolved': inherited_unknown_count == 0,
            'unknown_charges_and_transport_resolved': not unknown and inherited_unknown_count == 0,
            'experiment_finished': bool(status.get('finished_at')),
            'ten_groups_have_transport_evidence': len(group_stats) == 10 and all(g['first_request_start'] for g in group_stats)}
        report = {'schema_version': 'snippy-ten-group-benchmark-report-v1', 'generated_at': audit.now(),
            'experiment_id': plan.get('experiment_id'), 'plan_path': str(self.root / 'experiment-plan.json'),
            'authorized': {'groups': 10, 'group_size': 5, 'fresh_candidates': 50, 'frozen_ids': plan.get('candidate_ids', []),
                'wave_number': wave_number, 'wave_count': 2 if two_waves else 1,
                'total_fresh_candidates': 100 if two_waves else 50,
                'authorization_updated_at': context.get('authorization_updated_at'),
                'groups_by_lane': dict(Counter(group_lanes.values())), 'candidates_by_lane': dict(Counter(candidate_lanes.values()))},
            'baseline': {'covered_count': len(baseline), 'covered_ids': sorted(baseline),
                'mac_luna_cost_usd': mac_cost, 'first_shadow_luna_cost_usd': initial_shadow_cost,
                'previous_experiments_luna_cost_usd': previous_experiment_cost,
                'preserved_unknown_charge_count': inherited_unknown_count,
                'total_luna_cost_usd': baseline_cost, 'response_ids': sorted(baseline_response_ids),
                'frozen_request_paths': sorted(baseline_request_paths)},
            'counts': {'attempted': sum(r['attempted'] for r in coverage), 'pass': counts['pass'],
                'deferred': counts['deferred'], 'failed': counts['failed'], 'pending': counts['pending']},
            'phase': status.get('phase'), 'setup': setup, 'timing': timing, 'groups': group_stats, 'lanes': lanes,
            'measurement_caveats': context.get('measurement_caveats', []),
            'transport': {**overlap(intervals), 'request_attempts': len(starts),
                'retry_attempts': sum(max(0, r['transport_attempts_started'] - 1) for r in requests),
                'throttles_429': sum(e.get('http_status') == 429 for e in ends),
                'http_status_counts': dict(Counter(str(e.get('http_status')) for e in ends)),
                'roles': dict(Counter(e.get('role') for e in starts)), 'event_count': event_count,
                'intervals': intervals, 'unknown_or_unmatched': unknown,
                'preserved_baseline_unknown_or_unmatched': preserved_unknown},
            'api': {'unique_responses': len(responses), 'response_ids': sorted(request_ids),
                'token_categories': dict(tokens), 'usage_derived_cost_usd': cost,
                'cost_per_attempted_candidate_usd': cost / sum(r['attempted'] for r in coverage) if any(r['attempted'] for r in coverage) else None,
                'pricing_basis': 'Unchanged audit.price; actual saved API token usage, usage-derived estimate, not invoice. Unknown charges excluded.',
                'requests': requests, 'responses': responses},
            'gcs': {**transfer_totals, 'receipts': list(transfers.values()),
                'measurement': 'Selected fifty only; HTTP body/request upper bounds, not billed egress.'},
            'overrun_candidate_ids': overrun, 'unexplained_response_ids': sorted(unexplained),
            'unauthorized_request_paths': unauthorized_requests,
            'pending_ids': [r['candidate_id'] for r in coverage if r['outcome'] == 'pending'],
            'coverage': coverage, 'checks': checks, 'errors': self.errors,
            'passed': all(checks.values()), 'publication_success_for_all_fifty': counts['pass'] == 50,
            'stop_contract': stop_contract}
        audit.atomic(self.root / 'benchmark-report.json', report)
        self.markdown(report)
        return report

    def markdown(self, report):
        counts, timing, transport = report['counts'], report['timing'], report['transport']
        lines = [f"# Benchmark: {report['experiment_id']}", '',
            f"Receipt verification: **{'PASS' if report['passed'] else 'INCOMPLETE / FLAGGED'}**. 10 frozen groups of 5; wave {report['authorized']['wave_number']} of {report['authorized']['wave_count']} authorized waves.", '',
            f"Attempted {counts['attempted']}/50; passed {counts['pass']}; deferred to Astra {counts['deferred']}; failed {counts['failed']}; pending {counts['pending']}.", '',
            f"Experiment Luna usage-derived cost: **${report['api']['usage_derived_cost_usd']:.9f}** ({report['api']['unique_responses']} saved responses). This is an estimate from actual API usage, not an invoice; unknown charges are excluded.",
            f"Separate baseline: Mac ${report['baseline']['mac_luna_cost_usd']:.9f}; first Shadow batch ${report['baseline']['first_shadow_luna_cost_usd']:.9f}; previous experiment(s) ${report['baseline']['previous_experiments_luna_cost_usd']:.9f}.",
            f"Preserved baseline unknown charges/transport cases: **{report['baseline']['preserved_unknown_charge_count']}**; retained unresolved and excluded from known cost.", '',
            f"One-time setup before trial: {report['setup']['setup_before_trial_seconds']} s (claim {report['setup']['relay_claimed_at']} to trial {report['setup']['trial_started_at']}); excluded from throughput.",
            f"Total wall time: {timing['total_wall_seconds']} s; preparation: {timing['preparation_wall_seconds']} s; review/repair/publication phase: {timing['review_repair_publication_phase_seconds']} s.",
            f"Closed HTTP calls only: first-start to last-end span {transport['observed_http_span_seconds']} s; summed call time {transport['summed_http_call_seconds']} s; union of active-call time {transport['union_http_call_seconds']} s.",
            f"Measured HTTP overlap peak: {transport['peak_overlapping_requests']}; attempts {transport['request_attempts']}; retries {transport['retry_attempts']}; HTTP 429 responses {transport['throttles_429']}; unknown/unmatched calls {len(transport['unknown_or_unmatched'])}.",
            f"GCS body bytes: {report['gcs']['upstream_body_bytes_read']}; requested upper bound: {report['gcs']['upstream_requested_bytes']}; conservative response bound: {report['gcs']['conservative_response_bytes_upper_bound']}.", '',
            '| Check | Result |', '|---|---|']
        lines += [f"| {key} | {'PASS' if value else 'FAIL'} |" for key, value in report['checks'].items()]
        lines += ['', '| Lane | Groups | Candidates | Passed | Deferred | Failed | Pending | Luna cost | HTTP span (s) |',
                  '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
        for lane, value in report['lanes'].items():
            c = value['counts']
            lines.append(f"| {lane} | {value['groups']} | {value['candidates']} | {c['pass']} | {c['deferred']} | {c['failed']} | {c['pending']} | ${value['usage_derived_cost_usd']:.9f} | {value['http']['observed_http_span_seconds']} |")
        lines += ['', '| Token category | Count |', '|---|---:|']
        lines += [f'| {key} | {value} |' for key, value in sorted(report['api']['token_categories'].items())]
        if report['measurement_caveats']:
            lines += ['', 'Measurement context:', ''] + ['- '+item for item in report['measurement_caveats']]
        if report['errors']:
            lines += ['', 'Receipt errors:', ''] + [f"- {e['code']}: {e.get('path', e.get('candidate_id', 'see JSON'))}" for e in report['errors']]
        lines += ['', 'Full request/response IDs, timings, per-ID evidence, and pending IDs: [benchmark-report.json](benchmark-report.json).', '', report['stop_contract'], '']
        path = self.root / 'benchmark-report.md'
        temp = path.with_suffix('.md.tmp')
        temp.write_text('\n'.join(lines), encoding='utf-8')
        temp.replace(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--experiment-id')
    parser.add_argument('--claim-at', help='UTC Relay claim time; otherwise read benchmark-context.json relay_claimed_at')
    args = parser.parse_args(argv)
    report = BenchmarkReporter(args.root, args.experiment_id, args.claim_at).run()
    print(json.dumps({'experiment_id': report['experiment_id'], 'counts': report['counts'],
        'usage_derived_cost_usd': report['api']['usage_derived_cost_usd'],
        'peak_overlapping_requests': report['transport']['peak_overlapping_requests'],
        'passed': report['passed'], 'error_count': len(report['errors'])}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
