#!/usr/bin/env python3
"""Measured API/transfer accounting and lane-specific, versioned queue scenarios.

Read-only except report output. Posted rate assumptions are inputs, not invoices.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import statistics

import audit

ROOT = Path('.context/astra-clips')
GIB = 2 ** 30
RATES = {'egress_usd_gib': .12, 'replication_usd_gib': .02, 'storage_usd_gib_month': .026, 'class_a_usd_1000': .01, 'class_b_usd_1000': .0004, 'bigquery_usd_tib': 6.25}
SOURCES = ['https://developers.openai.com/api/docs/models/gpt-6-luna', 'https://cloud.google.com/storage/pricing', 'https://cloud.google.com/bigquery/pricing']


def read(path):
    return json.loads(Path(path).read_text())


def median(values, default=None):
    return statistics.median(values) if values else default


def manifests(root):
    pilot_path = root / 'pilot-manifest.json'
    pilot = read(pilot_path) if pilot_path.exists() else {'ids': [], 'lanes': {}}
    calibration_path = root / 'calibration20/manifest.json'
    calibration = read(calibration_path) if calibration_path.exists() else {}
    cohorts = {vid: {'cohort': 'original-five', 'lane': pilot.get('lanes', {}).get(vid), 'wave': None} for vid in pilot.get('ids', [])}
    for row in calibration.get('candidates', []):
        cohorts[row['candidate_id']] = {'cohort': 'calibration20', 'lane': row['lane'], 'wave': row['wave']}
    return cohorts, calibration


def prompt_identity(request):
    instructions = request.get('instructions', '')
    role = 'verifier' if 'independent Luna VERIFIER' in instructions else ('finalizer' if 'Luna FINALIZER' in instructions else 'preliminary')
    return {'role': role, 'prompt_sha256': hashlib.sha256(instructions.encode()).hexdigest()}


def collect_api(root, cohorts):
    unique = {}
    for path in sorted(root.rglob('response.json')):
        raw = read(path)
        if not str(raw.get('model', '')).startswith('gpt-6-luna') or not raw.get('id'):
            continue
        cost = audit.price(raw)
        if raw['id'] in unique:
            if unique[raw['id']]['usage'] != raw.get('usage'):
                raise ValueError('Conflicting usage for response ' + raw['id'])
            unique[raw['id']]['copies'].append(str(path))
            continue
        packages_path, request_path = path.parent / 'packages.json', path.parent / 'request.json'
        packages = read(packages_path) if packages_path.exists() else []
        ids = [p['evidence']['candidate_id'] for p in packages]
        request = read(request_path) if request_path.exists() else {}
        identity = prompt_identity(request)
        normalized = path.parent / 'results.json'
        row = {'response_id': raw['id'], 'cost_usd': cost, 'usage': raw.get('usage'), 'response_status': raw.get('status'), 'normalization_receipt_exists': normalized.exists(), 'candidate_ids': ids, 'path': str(path), 'copies': [str(path)], **identity}
        row['allocations'] = [{'candidate_id': vid, **cohorts.get(vid, {'cohort': 'other', 'lane': None, 'wave': None}), 'cost_usd': cost / len(ids)} for vid in ids]
        if not ids:
            row['allocations'] = [{'candidate_id': None, 'cohort': 'unattributed', 'lane': None, 'wave': None, 'cost_usd': cost}]
        unique[raw['id']] = row
    allocated = defaultdict(float)
    versioned = defaultdict(lambda: {'cost_usd': 0, 'response_count': 0, 'without_normalization_receipt': 0})
    for row in unique.values():
        for allocation in row['allocations']:
            key = (allocation['cohort'], allocation['lane'], allocation['wave'])
            allocated[key] += allocation['cost_usd']
        key = row['role'] + ':' + row['prompt_sha256']
        versioned[key]['cost_usd'] += row['cost_usd']
        versioned[key]['response_count'] += 1
        versioned[key]['without_normalization_receipt'] += not row['normalization_receipt_exists']
    return {'cost_usd': sum(row['cost_usd'] for row in unique.values()), 'response_count': len(unique), 'without_normalization_receipt_usd': sum(row['cost_usd'] for row in unique.values() if not row['normalization_receipt_exists']), 'by_cohort_lane_wave': [{'cohort': key[0], 'lane': key[1], 'wave': key[2], 'cost_usd': value} for key, value in sorted(allocated.items(), key=lambda item: str(item[0]))], 'by_prompt': dict(versioned), 'responses': list(unique.values())}


def collect_transfers(root, cohorts):
    # A receipt copied into result.json or a trimmed output is not another GET.
    # Exact transfer.json copies dedupe, but a real retry has new request times.
    unique = {}
    for path in sorted(root.rglob('transfer.json')):
        receipt = read(path)
        if 'upstream_body_bytes_read' not in receipt:
            continue
        identity = audit.digest(receipt)
        if identity in unique:
            unique[identity]['copies'].append(str(path))
            continue
        recipe_path = path.parent / 'recipe.json'
        vid = read(recipe_path).get('candidate_id') if recipe_path.exists() else path.parent.name[:11]
        unique[identity] = {'receipt_hash': identity, 'candidate_id': vid, **cohorts.get(vid, {'cohort': 'other', 'lane': None, 'wave': None}), 'bytes_read': receipt['upstream_body_bytes_read'], 'response_bytes_upper_bound': receipt.get('conservative_response_bytes_upper_bound'), 'failed': bool(receipt.get('errors')), 'elapsed_seconds': receipt.get('elapsed_seconds'), 'path': str(path), 'copies': [str(path)]}
    groups = defaultdict(list)
    for row in unique.values():
        groups[(row['cohort'], row['lane'])].append(row)
    def totals(rows):
        upper = [r['response_bytes_upper_bound'] for r in rows]
        complete_upper = all(isinstance(v, (int, float)) for v in upper)
        return {'attempts': len(rows), 'distinct_candidates': len({r['candidate_id'] for r in rows}), 'failed_attempts': sum(r['failed'] for r in rows), 'additional_attempts_including_retries': len(rows) - len({r['candidate_id'] for r in rows}), 'bytes_read': sum(r['bytes_read'] for r in rows), 'response_bytes_upper_bound': sum(upper) if complete_upper else None, 'egress_estimate_from_read_bytes_usd': sum(r['bytes_read'] for r in rows) / GIB * RATES['egress_usd_gib'], 'egress_upper_scenario_usd': sum(upper) / GIB * RATES['egress_usd_gib'] if complete_upper else None}
    metered_failures = {row['candidate_id'] for row in unique.values() if row['failed']}
    unmetered_failures = [{'candidate_id': read(path).get('candidate_id'), 'path': str(path), 'error': read(path).get('error')} for path in (root / 'calibration20/network-failures').glob('*.json') if read(path).get('candidate_id') not in metered_failures]
    return {'unmetered_failure_reports': unmetered_failures, 'totals': totals(list(unique.values())), 'by_cohort_lane': [{**{'cohort': key[0], 'lane': key[1]}, **totals(rows)} for key, rows in sorted(groups.items(), key=lambda item: str(item[0]))], 'attempts': list(unique.values()), 'measurement': 'HTTP body bytes read and full bounded response lengths, not invoiced egress. Includes failed/retried source reads; excludes local reencoding and copied result headers.'}


def collect_pipelines(root, cohorts):
    seen = {}
    paths = sorted(root.rglob('pipeline-results.json')) + sorted(root.glob('experiment-*-results.json'))
    for path in paths:
        result = read(path)
        key = result.get('run_hash')
        if not key or key in seen:
            continue
        ledger_path = Path(result.get('ledger_path', ''))
        if not ledger_path.is_file():
            continue
        ledger = read(ledger_path)
        role_prompts = {}
        allocations = defaultdict(float)
        first_round = defaultdict(float)
        calls_seen = set()
        for turn in ledger['rounds']:
            for role in ('finalizer', 'verifier'):
                call = turn.get(role)
                if not call or call.get('response_id') in calls_seen:
                    continue
                calls_seen.add(call['response_id'])
                artifact = Path(call.get('artifact_directory', '')) / 'request.json'
                if artifact.is_file():
                    role_prompts[role] = prompt_identity(read(artifact))['prompt_sha256']
                decisions = call.get('decisions', [])
                for decision in decisions:
                    allocations[decision['candidate_id']] += call['cost_usd'] / len(decisions)
                    if turn['pass'] == 1:
                        first_round[decision['candidate_id']] += call['cost_usd'] / len(decisions)
        version = audit.digest(role_prompts) if len(role_prompts) == 2 else 'unknown'
        seen[key] = {'run_hash': key, 'created_at': result.get('created_at', ''), 'prompt_version': version, 'role_prompt_hashes': role_prompts, 'cost_usd': result.get('cost_usd'), 'elapsed_seconds': result.get('elapsed_seconds'), 'path': str(path), 'decisions': [{**d, **cohorts.get(d['candidate_id'], {'cohort': 'other', 'lane': None, 'wave': None}), 'allocated_model_usd': allocations.get(d['candidate_id'], 0), 'first_round_model_usd': first_round.get(d['candidate_id'], 0)} for d in result['decisions']]}
    return sorted(seen.values(), key=lambda r: r['created_at'])


def prompt_versions(runs):
    groups = defaultdict(list)
    for run in runs:
        groups[run['prompt_version']].append(run)
    result = []
    for version, grouped in groups.items():
        by_lane = {}
        for lane in ('eligible', 'review'):
            rows = [d for run in grouped for d in run['decisions'] if d['lane'] == lane]
            unique = {d['candidate_id'] for d in rows}
            by_lane[lane] = {'distinct_clips': len(unique), 'clip_runs': len(rows), 'mean_luna_usd_per_clip_run': statistics.mean(d['allocated_model_usd'] for d in rows) if rows else None, 'mean_first_round_usd': statistics.mean(d['first_round_model_usd'] for d in rows) if rows else None, 'round_counts': dict(Counter(str(d.get('attempts')) for d in rows)), 'status_counts': dict(Counter(d['status'] for d in rows))}
        result.append({'prompt_version': version, 'role_prompt_hashes': grouped[0]['role_prompt_hashes'], 'most_recent_completed_run': max(r['created_at'] for r in grouped), 'runs': len(grouped), 'by_lane': by_lane, 'enough_for_latest_baseline': version != 'unknown' and all(by_lane[lane]['distinct_clips'] >= 3 for lane in by_lane), 'run_hashes': [r['run_hash'] for r in grouped]})
    return sorted(result, key=lambda v: v['most_recent_completed_run'])


def media_samples(root, cohorts, transfers, runs):
    originals = {}
    for vid in cohorts:
        receipt_path = root / 'calibration20/receipts' / f'{vid}.json'
        if receipt_path.exists():
            receipt = read(receipt_path)
            if receipt.get('directory'):
                originals[vid] = Path(receipt['directory'])
    for path in (root / 'rendered').glob('*/result.json'):
        vid = read(path)['candidate_id']
        if vid in cohorts:
            originals.setdefault(vid, path.parent)
    final = {}
    for run in runs:
        for decision in run['decisions']:
            if decision.get('media_path'):
                final[decision['candidate_id']] = Path(decision['media_path']).parent
    measurements = []
    for vid, directory in originals.items():
        paths = [directory / 'result.json', directory / 'recipe.json', root / 'candidates' / f'{vid}.json']
        if not all(path.exists() for path in paths):
            continue
        result, recipe, packet = (read(path) for path in paths)
        obj = packet.get('gcs_object')
        if not obj:
            continue
        seconds = packet['source_duration_seconds']
        initial_seconds = sum(e['end_seconds'] - e['start_seconds'] for e in recipe['edits'])
        attempts = [a for a in transfers['attempts'] if a['candidate_id'] == vid]
        upper = [a['response_bytes_upper_bound'] for a in attempts]
        if not upper or not all(isinstance(v, (int, float)) for v in upper):
            continue
        final_path = final.get(vid, directory) / 'result.json'
        last = read(final_path) if final_path.exists() else result
        proposal = packet['luna_proposal']['end_seconds'] - packet['luna_proposal']['start_seconds']
        if proposal <= 0 or seconds <= 0:
            continue
        initial_payload = int(obj['size']) * initial_seconds / seconds
        final_payload = int(obj['size']) * last['duration_seconds'] / seconds
        measurements.append({'candidate_id': vid, **cohorts[vid], 'read_upper_bytes_including_retries': sum(upper), 'transfer_attempts': len(attempts), 'extra_read_bytes_including_retries': max(0, sum(upper) - initial_payload), 'final_duration_to_proposal_ratio': last['duration_seconds'] / proposal, 'output_size_to_source_payload_ratio': last['output_bytes'] / max(1, final_payload)})
    return measurements


def project(candidates, version, measurements):
    rows = []
    for lane in ('eligible', 'review'):
        population = [p for p in candidates if p.get('gcs_object') and p['lane'] == lane]
        measured = [m for m in measurements if m['lane'] == lane]
        model = version['by_lane'][lane]
        if not measured or model['mean_luna_usd_per_clip_run'] is None:
            rows.append({'lane': lane, 'candidates': len(population), 'projection_available': False, 'reason': 'Insufficient model or transfer measurements for this lane'})
            continue
        n = len(population)
        overhead = median([m['extra_read_bytes_including_retries'] for m in measured])
        expansion = median([m['final_duration_to_proposal_ratio'] for m in measured])
        encoding = median([m['output_size_to_source_payload_ratio'] for m in measured])
        def payload(ratio):
            return sum(int(p['gcs_object']['size']) * min(240, max(15, (p['luna_proposal']['end_seconds'] - p['luna_proposal']['start_seconds']) * ratio)) / max(1, p['source_duration_seconds']) for p in population)
        final_payload = payload(expansion)
        source_bytes = max(final_payload, payload(1)) + n * overhead
        output_bytes = final_payload * encoding
        model_cost = n * model['mean_luna_usd_per_clip_run']
        network = source_bytes / GIB * RATES['egress_usd_gib']
        replication = output_bytes / GIB * RATES['replication_usd_gib']
        operations = n * RATES['class_a_usd_1000'] / 1000 + (source_bytes / (2 ** 20) + n * 5) * RATES['class_b_usd_1000'] / 1000
        bigquery = n * (4 * 10 * 2 ** 20) / (2 ** 40) * RATES['bigquery_usd_tib']
        cloud = network + replication + operations + bigquery
        rows.append({'lane': lane, 'candidates': n, 'skipped_missing_source': sum(p['lane'] == lane and not p.get('gcs_object') for p in candidates), 'projection_available': True, 'model_distinct_clips': model['distinct_clips'], 'media_sample_clips': len(measured), 'luna_usd_per_clip': model['mean_luna_usd_per_clip_run'], 'luna_usd': model_cost, 'source_egress_usd': network, 'replication_usd': replication, 'storage_operations_usd': operations, 'bigquery_usd': bigquery, 'one_time_usd': model_cost + cloud, 'storage_usd_month': output_bytes / GIB * RATES['storage_usd_gib_month'], 'one_playback_each_usd': output_bytes / GIB * RATES['egress_usd_gib'], 'all_five_rounds_usd': n * model['mean_first_round_usd'] * 5 + cloud, 'full_source_download_usd': sum(int(p['gcs_object']['size']) for p in population) / GIB * RATES['egress_usd_gib'], 'estimated_source_GiB': source_bytes / GIB, 'estimated_output_GiB': output_bytes / GIB, 'assumptions': {'median_extra_read_bytes_including_retries': overhead, 'median_final_duration_ratio': expansion, 'median_reencode_size_ratio': encoding}})
    keys = ['candidates', 'luna_usd', 'source_egress_usd', 'replication_usd', 'storage_operations_usd', 'bigquery_usd', 'one_time_usd', 'storage_usd_month', 'one_playback_each_usd', 'all_five_rounds_usd', 'full_source_download_usd']
    totals = {key: sum(r.get(key, 0) for r in rows) for key in keys} if all(r['projection_available'] for r in rows) else None
    if totals:
        totals['ten_similar_clips_usd'] = totals['one_time_usd'] / max(1, totals['candidates']) * 10
    return {'prompt_version': version['prompt_version'], 'sufficient_sample': version['enough_for_latest_baseline'], 'rows': rows, 'totals': totals}


def estimate(root):
    cohorts, calibration = manifests(root)
    candidates = [read(p) for p in (root / 'candidates').glob('*.json')]
    api, transfers = collect_api(root, cohorts), collect_transfers(root, cohorts)
    runs = collect_pipelines(root, cohorts)
    versions = prompt_versions(runs)
    measurements = media_samples(root, cohorts, transfers, runs)
    projections = [project(candidates, version, measurements) for version in versions]
    eligible = [v for v in versions if v['enough_for_latest_baseline']]
    baseline = eligible[-1] if eligible else (versions[-1] if versions else None)
    selected = next((p for p in projections if baseline and p['prompt_version'] == baseline['prompt_version']), None)
    quality_reports = []
    for path in (root / 'calibration20').rglob('calibration.json'):
        result = read(path)
        if result.get('schema_version') == 'snippy-luna-calibration-v1':
            quality_reports.append({'path': str(path), 'summary': result['summary'], 'by_wave': result.get('by_wave', {}), 'by_lane': result.get('by_lane', {})})
    receipt_counts = Counter(read(p).get('status', 'unknown') for p in (root / 'calibration20/receipts').glob('*.json'))
    return {'time': audit.now(), 'scope': 'Only GCS-available candidates; missing footage excluded by user instruction', 'population': {'available': sum(bool(p.get('gcs_object')) for p in candidates), 'missing_footage_excluded': sum(not p.get('gcs_object') for p in candidates), 'by_lane': {lane: sum(bool(p.get('gcs_object')) and p['lane'] == lane for p in candidates) for lane in ('eligible', 'review')}}, 'rows': selected['rows'] if selected else [], 'totals': selected['totals'] if selected else None, 'baseline_selection': {'prompt_version': baseline['prompt_version'] if baseline else None, 'sufficient_sample': bool(baseline and baseline['enough_for_latest_baseline']), 'rule': 'Newest completed prompt version with at least three distinct clips per lane. If none qualifies, latest version is explicitly provisional.', 'newer_insufficient_versions': [v['prompt_version'] for v in versions if baseline and v['most_recent_completed_run'] > baseline['most_recent_completed_run']]}, 'versioned_measurements': versions, 'versioned_projections': projections, 'actual_api': api, 'actual_pilot_api_spend_usd': api['cost_usd'], 'actual_response_count': api['response_count'], 'actual_gcs_transfers': transfers, 'media_samples': measurements, 'calibration20': {'selected': len(calibration.get('candidates', [])), 'preparation_statuses': dict(receipt_counts), 'selection_method': calibration.get('selection_method'), 'quality_reports': quality_reports}, 'completed_pipeline_runs': runs, 'rate_assumptions': RATES, 'limitations': ['Selected pilots and calibration candidates are small, non-random samples; repeated experiments increase clip-runs, not independent clip diversity.', 'Calibration sampling excludes objects of at least 1GB and enforces distinct speaker strings; its measured transfer overhead may not represent larger library objects.', 'Prompt versions are measured separately. Projection baseline requires three distinct clips per lane; even this threshold is a scenario, not statistical confidence.', 'Luna batch costs are allocated equally to participating candidates because API usage is reported for the batch, not each clip. Actual spend includes raw failed/unaccepted responses, deduplicated by response ID.', 'Source reads include failed attempts and retries. Range receipts are not invoices; response-byte upper bounds can overstate transferred bytes. Exact copies and local trim/result headers are not extra GCS requests.', 'Media expansion/encoding ratios pool available original and calibration clips; version-specific editorial differences may change output size.', 'Scenarios assume every media-available candidate enters the loop. Editorial deferrals, Astra subscription usage/escalations, missing-source acquisition, machine/Shadow subscription and electricity are not priced.', 'All-five-rounds uses measured first-round cost; it is not a hard spending cap. Posted rates exclude allowances, discounts, taxes and unrecorded future retries.'], 'sources': SOURCES}


def save(report, root):
    audit.atomic(root / 'cost-estimate.json', report)
    lines = ['# Measured costs and queue scenarios', '', report['scope'], '', '| Queue | Clips | Luna | GCS + database | Total once | Storage/month |', '|---|---:|---:|---:|---:|---:|']
    for row in report['rows']:
        if row['projection_available']:
            lines.append(f"| {row['lane']} | {row['candidates']:,} | ${row['luna_usd']:.2f} | ${row['one_time_usd']-row['luna_usd']:.2f} | ${row['one_time_usd']:.2f} | ${row['storage_usd_month']:.2f} |")
    if report['totals']:
        totals = report['totals']
        lines += ['', f"Combined scenario: ${totals['one_time_usd']:.2f} once, ${totals['storage_usd_month']:.2f}/month. Ten similar clips: ${totals['ten_similar_clips_usd']:.3f}."]
    lines += ['', 'Baseline: ' + str(report['baseline_selection']), '', f"Recorded Luna spend including failed calls: ${report['actual_api']['cost_usd']:.6f} / {report['actual_api']['response_count']} unique responses.", '', '## Prompt-version measurements', '', '| Version | Lane | Distinct clips | Clip-runs | Mean Luna/clip |', '|---|---|---:|---:|---:|']
    for version in report['versioned_measurements']:
        for lane, row in version['by_lane'].items():
            cost = f"${row['mean_luna_usd_per_clip_run']:.6f}" if row['mean_luna_usd_per_clip_run'] is not None else 'unmeasured'
            lines.append(f"| {version['prompt_version'][:12]} | {lane} | {row['distinct_clips']} | {row['clip_runs']} | {cost} |")
    lines += ['', '## Measurement limits', '', *['- ' + text for text in report['limitations']], '', 'Rates: ' + ', '.join(report['sources'])]
    (root / 'cost-estimate.md').write_text('\n'.join(lines) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    report = estimate(args.root)
    save(report, args.root)
    print(json.dumps({'population': report['population'], 'baseline_selection': report['baseline_selection'], 'totals': report['totals'], 'actual_api_spend_usd': report['actual_api']['cost_usd'], 'actual_transfer_totals': report['actual_gcs_transfers']['totals']}, indent=2))


if __name__ == '__main__':
    main()
