#!/usr/bin/env python3
"""Read-only, hash-bound comparison of Luna pipelines and independent Astra QA.

No model calls or media changes. Blind verdicts determine calibration; later
review of disagreements is recorded separately and cannot overwrite that baseline.
"""
import argparse
from collections import Counter
import csv
import json
from pathlib import Path

import audit
from process_astra import require, sha

VERDICTS = {'PASS': 'pass', 'FIX_REQUIRED': 'fix_required', 'REVIEW': 'review', 'NEEDS_REVIEW': 'review', 'REJECT': 'reject', 'FAIL': 'fix_required'}


def read(path):
    return json.loads(Path(path).read_text())


def paths_from(patterns):
    paths = []
    for pattern in patterns:
        path = Path(pattern)
        if path.is_dir():
            paths.extend(sorted(path.rglob('pipeline-results.json')))
        else:
            require(path.is_file(), f'Missing input: {path}')
            paths.append(path)
    return paths


def verify_artifacts(media_path, recipe_path, media_hash, recipe_hash):
    if not media_path or not recipe_path:
        return False, 'Missing artifact paths'
    media, recipe = Path(media_path), Path(recipe_path)
    if not media.is_file() or not recipe.is_file():
        return False, 'Artifact not available locally'
    if sha(media) != media_hash or audit.digest(read(recipe)) != recipe_hash:
        return False, 'Artifact hash drift'
    return True, None


def manifest_candidates(manifest):
    if not manifest.get('ids') and manifest.get('candidates'):
        manifest['ids'] = [row['candidate_id'] for row in manifest['candidates']]
        manifest['lanes'] = {row['candidate_id']: row['lane'] for row in manifest['candidates']}
        waves = {}
        for row in manifest['candidates']:
            waves.setdefault(str(row.get('wave', 'unspecified')), []).append(row['candidate_id'])
        manifest['waves'] = [{'wave_id': wave, 'ids': ids} for wave, ids in waves.items()]
    ids = manifest.get('ids', [])
    require(isinstance(ids, list) and ids and len(ids) == len(set(ids)), 'Manifest needs unique ids')
    lanes = manifest.get('lanes', {})
    wave_map = {}
    for wave in manifest.get('waves', []):
        for vid in wave['ids']:
            require(vid in ids and vid not in wave_map, 'Wave IDs must be unique manifest members')
            wave_map[vid] = wave['wave_id']
    return ids, lanes, wave_map


def astra_records(paths):
    records = []
    for path in paths:
        report = read(path)
        # Legacy reports may claim independence in prose, but absence of the
        # explicit blind flag must not silently count as a blind calibration.
        phase = report.get('review_phase', 'unspecified')
        blind = phase == 'blind' and report.get('blind_to_luna_decisions') is True
        for clip in report.get('clips', []):
            vid = clip.get('candidate_id', clip.get('video_id'))
            verdict = VERDICTS.get(str(clip.get('verdict', '')).upper())
            require(vid and verdict and clip.get('media_sha256') and clip.get('recipe_hash'), f'Unbound or invalid Astra verdict in {path}')
            records.append({**clip, 'candidate_id': vid, 'verdict': verdict, 'review_phase': phase, 'blind': blind, 'report_path': str(path.resolve())})
    return records


def match_astra(records, vid, media_hash, recipe_hash, blind=True):
    matches = [r for r in records if r['candidate_id'] == vid and r['media_sha256'] == media_hash and r['recipe_hash'] == recipe_hash and (r['blind'] if blind else not r['blind'])]
    if not matches:
        return None, 'unreviewed'
    if len({r['verdict'] for r in matches}) != 1:
        return None, 'conflicting_reports'
    return matches[-1], matches[-1]['verdict']


def unnecessary_edit(record, original, edited):
    judgment = (record or {}).get('unnecessary_edit') or {}
    verdict = judgment.get('verdict', 'unassessed').lower()
    if verdict not in ('yes', 'no'):
        return 'unassessed'
    if edited is not True or not original:
        return 'unassessed'
    valid, _ = verify_artifacts(original.get('media_path'), original.get('recipe_path'), judgment.get('original_media_sha256'), judgment.get('original_recipe_hash'))
    return verdict if valid else 'unassessed'


def summarize(rows):
    paired = [r for r in rows if r['luna_status'] == 'pass' and r['astra_blind_verdict'] in ('pass', 'fix_required', 'reject')]
    false = [r for r in paired if r['false_approval'] is True]
    return {'rows': len(rows), 'luna_status_counts': dict(Counter(r['luna_status'] for r in rows)), 'astra_blind_status_counts': dict(Counter(r['astra_blind_verdict'] for r in rows)), 'paired_luna_approvals_with_definite_astra_verdict': len(paired), 'false_approvals': len(false), 'false_approval_rate': len(false) / len(paired) if paired else None, 'unnecessary_edits_confirmed': sum(r['unnecessary_edit'] == 'yes' for r in rows), 'unnecessary_edits_assessed': sum(r['unnecessary_edit'] in ('yes', 'no') for r in rows), 'luna_rounds_total': sum(r.get('attempts') or 0 for r in rows), 'luna_round_counts': dict(Counter(str(r['attempts']) for r in rows if r.get('attempts')))}


def compare(manifest_path, pipeline_paths, astra_paths):
    manifest = read(manifest_path)
    ids, lanes, waves = manifest_candidates(manifest)
    for vid in ids:
        receipt_path = Path(manifest_path).parent / 'receipts' / f'{vid}.json'
        if receipt_path.exists():
            receipt = read(receipt_path)
            if receipt.get('status') == 'not_rendered':
                manifest.setdefault('not_rendered', {}).setdefault(vid, receipt.get('reason', 'Explicit preparation deferral'))
            if receipt.get('directory'):
                directory = Path(receipt['directory'])
                manifest.setdefault('originals', {}).setdefault(vid, {'media_path': str(directory / 'clip.mp4'), 'recipe_path': str(directory / 'recipe.json')})
    reports = astra_records(astra_paths)
    require(all(r['candidate_id'] in ids for r in reports), 'Astra report includes a candidate outside manifest')
    rows, seen_runs, seen_ids, costs = [], {}, set(), {}
    for pipeline_path in pipeline_paths:
        pipeline = read(pipeline_path)
        run_id = pipeline.get('run_hash') or audit.digest(pipeline)
        if run_id in seen_runs:
            require(audit.digest(seen_runs[run_id]['decisions']) == audit.digest(pipeline['decisions']), 'Conflicting pipeline copies for same run_hash')
            continue
        seen_runs[run_id] = pipeline
        costs[run_id] = {'pipeline_cost_usd': pipeline.get('cost_usd'), 'api_response_ids': pipeline.get('batch_response_ids', []), 'pipeline_path': str(pipeline_path.resolve()), 'elapsed_seconds': pipeline.get('elapsed_seconds')}
        decisions = pipeline.get('decisions', [])
        decision_ids = [d.get('candidate_id') for d in decisions]
        require(len(decision_ids) == len(set(decision_ids)) and set(decision_ids) <= set(ids), 'Duplicate or unknown pipeline candidate')
        for decision in decisions:
            vid = decision['candidate_id']
            seen_ids.add(vid)
            media_hash, recipe_hash = decision.get('media_sha256'), decision.get('recipe_hash')
            valid, error = verify_artifacts(decision.get('media_path'), decision.get('recipe_path'), media_hash, recipe_hash)
            raw_status = decision.get('status')
            if not valid:
                status = 'invalid_artifact'
            elif raw_status == 'pass' and decision.get('complete') is True:
                final_qa_path = Path(decision['media_path']).parent / 'final-qa.json'
                final = read(final_qa_path) if final_qa_path.exists() else {}
                verified = final.get('passed') is True and final.get('media_sha256') == media_hash and final.get('recipe_hash') == recipe_hash
                status = 'pass' if verified else 'unverified_pass_claim'
                if not verified:
                    error = 'No matching final-qa receipt'
            elif raw_status == 'escalated' and decision.get('complete') is False:
                status = 'escalated'
            else:
                status = 'unreviewed'
            astra, blind_status = match_astra(reports, vid, media_hash, recipe_hash)
            later, later_status = match_astra(reports, vid, media_hash, recipe_hash, blind=False)
            if not valid:
                astra, blind_status = None, 'unreviewed'
            original = manifest.get('originals', {}).get(vid)
            edited = None
            if original and Path(original.get('media_path', '')).is_file() and Path(original.get('recipe_path', '')).is_file():
                edited = sha(original['media_path']) != media_hash or audit.digest(read(original['recipe_path'])) != recipe_hash
            unnecessary = unnecessary_edit(astra, original, edited)
            unnecessary_phase = 'blind' if unnecessary != 'unassessed' else None
            if unnecessary == 'unassessed' and later and later['review_phase'] == 'discrepancy':
                unnecessary = unnecessary_edit(later, original, edited)
                unnecessary_phase = 'discrepancy' if unnecessary != 'unassessed' else None
            rows.append({'candidate_id': vid, 'lane': lanes.get(vid, 'unknown'), 'wave': waves.get(vid, 'unspecified'), 'run_hash': run_id, 'luna_status': status, 'luna_reported_status': raw_status, 'attempts': decision.get('attempts'), 'astra_blind_verdict': blind_status, 'astra_reason': (astra or {}).get('reason'), 'discrepancy_review_verdict': later_status, 'discrepancy_reason': (later or {}).get('reason'), 'false_approval': status == 'pass' and blind_status in ('fix_required', 'reject') if blind_status in ('pass', 'fix_required', 'reject') else None, 'edited': edited, 'unnecessary_edit': unnecessary, 'unnecessary_edit_review_phase': unnecessary_phase, 'media_sha256': media_hash, 'recipe_hash': recipe_hash, 'media_path': decision.get('media_path'), 'recipe_path': decision.get('recipe_path'), 'artifact_error': error, 'pipeline_path': str(pipeline_path.resolve()), 'astra_report_path': (astra or {}).get('report_path')})
    for vid in ids:
        if vid in seen_ids:
            continue
        not_rendered = manifest.get('not_rendered', {}).get(vid)
        original = manifest.get('originals', {}).get(vid, {})
        status = 'not_rendered' if not_rendered else 'unreviewed'
        rows.append({'candidate_id': vid, 'lane': lanes.get(vid, 'unknown'), 'wave': waves.get(vid, 'unspecified'), 'run_hash': None, 'luna_status': status, 'luna_reported_status': None, 'attempts': None, 'astra_blind_verdict': 'unreviewed', 'false_approval': None, 'edited': None, 'unnecessary_edit': 'unassessed', 'artifact_error': not_rendered or 'No completed pipeline decision supplied', 'media_path': original.get('media_path'), 'recipe_path': original.get('recipe_path')})
    all_response_ids = [rid for cost in costs.values() for rid in cost['api_response_ids']]
    overlap = len(all_response_ids) != len(set(all_response_ids))
    known_costs = [cost['pipeline_cost_usd'] for cost in costs.values() if isinstance(cost['pipeline_cost_usd'], (int, float))]
    return {'schema_version': 'snippy-luna-calibration-v1', 'created_at': audit.now(), 'manifest_path': str(Path(manifest_path).resolve()), 'summary': summarize(rows), 'by_wave': {wave: summarize([r for r in rows if r['wave'] == wave]) for wave in sorted({r['wave'] for r in rows})}, 'by_lane': {lane: summarize([r for r in rows if r['lane'] == lane]) for lane in sorted({r['lane'] for r in rows})}, 'rows': rows, 'pipeline_costs': costs, 'cost_usd': sum(known_costs) if not overlap and len(known_costs) == len(costs) else None, 'cost_warning': 'Shared response IDs across different runs; pipeline totals would double-count' if overlap else ('Some pipeline costs missing' if len(known_costs) != len(costs) else None), 'limitations': ['Cost includes supplied completed pipeline receipts only; aborted or other API calls are not silently included.', 'Unnecessary edits require an explicit Astra comparison bound to both original and final hashes; changed media alone is not evidence of an unnecessary edit.', 'Only explicitly blind Astra reports count toward the calibration baseline; discrepancy reviews remain separate.', 'Absent pipeline decisions are unreviewed unless the manifest explicitly records not_rendered.']}


def save_report(result, output):
    output = Path(output)
    audit.atomic(output / 'calibration.json', result)
    columns = ['wave', 'candidate_id', 'lane', 'run_hash', 'luna_status', 'attempts', 'astra_blind_verdict', 'false_approval', 'edited', 'unnecessary_edit', 'discrepancy_review_verdict', 'artifact_error', 'media_path', 'recipe_path', 'astra_reason']
    with (output / 'paired-results.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(result['rows'])
    def safe(value):
        return str(value if value is not None else '—').replace('|', '\\|').replace('\n', ' ')
    lines = ['# Luna / Astra calibration', '', '| Wave | Candidate | Luna | Rounds | Blind Astra | False approval | Unnecessary edit |', '|---|---|---|---:|---|---|---|']
    for row in result['rows']:
        lines.append('| ' + ' | '.join(safe(row.get(k)) for k in ('wave', 'candidate_id', 'luna_status', 'attempts', 'astra_blind_verdict', 'false_approval', 'unnecessary_edit')) + ' |')
    lines.extend(['', '```json', json.dumps(result['summary'], indent=2), '```', '', 'Completed pipeline cost: ' + (f"${result['cost_usd']:.8f}" if result['cost_usd'] is not None else 'unresolved'), '', *result['limitations']])
    (output / 'calibration.md').write_text('\n'.join(lines) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--pipelines', nargs='*', default=[], help='Pipeline JSON files or directories containing pipeline-results.json')
    parser.add_argument('--astra', nargs='*', default=[], type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = compare(args.manifest, paths_from(args.pipelines), args.astra)
    save_report(result, args.output)
    print(json.dumps({'summary': result['summary'], 'cost_usd': result['cost_usd'], 'report': str((args.output / 'calibration.md').resolve())}, indent=2))


if __name__ == '__main__':
    main()
