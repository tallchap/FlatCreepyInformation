#!/usr/bin/env python3
"""Verify the held-out 15-clip calibration goal, without model or network calls.

Use --pipelines with explicit pipeline-results.json files for the chosen prompt
version, not directories. Their run hashes are pinned in the output receipt.
Historical runs in calibration.json are excluded; repeated selected candidates
fail closed rather than inflating the denominator.
"""
import argparse
from collections import Counter
import json
from pathlib import Path

import audit
import calibrate_luna as calibration_tools


ORIGINAL_PILOTS = {'6uwtlbPUjgo', 'OPZxs6IXH00', 'r8cpy1Gxe0o', 'vuYKvMH3ai4', 'vf7Osd-FclA'}
TARGET = .95


def wave_number(value):
    return str(value).removeprefix('wave-')


def check_goal(manifest, comparison, pipelines):
    """pipelines is a list of (explicit path, parsed pipeline) pairs."""
    errors, checks = [], []

    def check(name, passed, detail):
        checks.append({'check': name, 'passed': bool(passed), 'detail': detail})
        if not passed:
            errors.append(detail)

    candidates = manifest.get('candidates', [])
    ids = [row.get('candidate_id') for row in candidates]
    check('unique_manifest_ids', all(isinstance(x, str) and x for x in ids) and len(ids) == len(set(ids)),
          'Manifest candidate IDs must be nonempty and unique.')
    check('original_pilots_excluded', not (set(ids) & ORIGINAL_PILOTS),
          'Original five pilots must not occur in the calibration denominator.')
    check('hard_cap_30', len(ORIGINAL_PILOTS) + len(candidates) <= 30,
          f'Total selected: original 5 + {len(candidates)} calibration rows; cap is 30.')
    fresh_rows = [row for row in candidates if wave_number(row.get('wave')) in ('2', '3')]
    fresh = {row['candidate_id'] for row in fresh_rows}
    counts = Counter(wave_number(row.get('wave')) for row in candidates)
    check('fixed_training_and_validation_scope', counts == {'1': 10, '2': 10, '3': 5},
          'Require 10 wave-1 training clips, 10 wave-2 and 5 wave-3 held-out clips; do not shrink the denominator.')
    check('comparison_schema', comparison.get('schema_version') == 'snippy-luna-calibration-v1',
          'Input must be a calibration.json produced by calibrate_luna.')

    selected_runs, selected_decisions, selected_metadata = {}, [], []
    check('explicit_pipeline_selection', bool(pipelines), 'Supply explicit current-version pipeline JSON files.')
    for path, pipeline in pipelines:
        run = pipeline.get('run_hash')
        check('selected_run_hash', isinstance(run, str) and bool(run), f'Pipeline lacks a run_hash: {path}')
        check('unique_selected_run', run not in selected_runs, f'Duplicate selected run_hash: {run}')
        selected_runs[run] = pipeline
        decisions = pipeline.get('decisions', [])
        selected_metadata.append({'path': str(Path(path).resolve()), 'run_hash': run,
                                  'candidate_ids': [d.get('candidate_id') for d in decisions]})
        for decision in decisions:
            selected_decisions.append((run, decision))
    selected_ids = [d.get('candidate_id') for _, d in selected_decisions]
    check('unique_selected_candidates', len(selected_ids) == len(set(selected_ids)),
          'A candidate occurs in multiple selected decisions/reruns; select exactly one run per candidate.')
    check('exact_selected_membership', set(selected_ids) == fresh,
          f'Selected pipelines must cover exactly the held-out IDs. Missing: {sorted(fresh - set(selected_ids))}; '
          f'outside scope: {sorted(str(x) for x in set(selected_ids) - fresh)}.')

    rows = [row for row in comparison.get('rows', []) if row.get('run_hash') in selected_runs]
    previously_reviewed = sorted({row.get('candidate_id') for row in comparison.get('rows', [])
                                  if row.get('candidate_id') in fresh and row.get('run_hash')
                                  and row.get('run_hash') not in selected_runs
                                  and row.get('astra_blind_verdict') in ('pass', 'fix_required', 'reject', 'review')})
    check('held_out_not_previously_reviewed', not previously_reviewed,
          f'Prior blind-reviewed runs of selected clips are repeated measurements, not fresh validation: {previously_reviewed}.')
    row_ids = [row.get('candidate_id') for row in rows]
    check('unique_comparison_candidates', len(row_ids) == len(set(row_ids)),
          'Duplicate selected candidate rows in comparison; reruns cannot inflate fresh validation.')
    check('exact_comparison_membership', set(row_ids) == fresh,
          'Comparison must contain exactly one row for each held-out candidate from the explicitly selected runs.')
    decision_map = {(run, d.get('candidate_id')): d for run, d in selected_decisions}
    manifest_map = {row['candidate_id']: row for row in fresh_rows}
    outcomes = []
    for row in rows:
        vid, run = row.get('candidate_id'), row.get('run_hash')
        decision = decision_map.get((run, vid))
        bound = decision is not None and all(row.get(k) == decision.get(k) and row.get(k)
                                            for k in ('media_sha256', 'recipe_hash', 'media_path', 'recipe_path'))
        member = manifest_map.get(vid, {})
        check('row_run_artifact_binding', bound, f'{vid}: comparison must match selected run and artifact hashes/paths.')
        check('row_wave_lane_binding', wave_number(row.get('wave')) == wave_number(member.get('wave'))
              and row.get('lane') == member.get('lane'), f'{vid}: comparison wave/lane differs from manifest.')
        artifact_ok, artifact_error = calibration_tools.verify_artifacts(
            row.get('media_path'), row.get('recipe_path'), row.get('media_sha256'), row.get('recipe_hash'))
        blind_status = 'unreviewed'
        report_path = row.get('astra_report_path')
        if artifact_ok and report_path:
            try:
                reports = calibration_tools.astra_records([Path(report_path)])
                _, blind_status = calibration_tools.match_astra(reports, vid, row.get('media_sha256'), row.get('recipe_hash'))
            except (ValueError, OSError, KeyError, TypeError):
                blind_status = 'unreviewed'
        check('unchanged_blind_evidence', blind_status == row.get('astra_blind_verdict'),
              f'{vid}: blind evidence changed or unavailable; rerun calibrate_luna for the selected hashes.')
        luna_pass = row.get('luna_status') == 'pass' and bound and artifact_ok
        if luna_pass:
            qa_path = Path(row['media_path']).parent / 'final-qa.json'
            try:
                qa = calibration_tools.read(qa_path)
            except (OSError, ValueError):
                qa = {}
            luna_pass = (decision.get('status') == 'pass' and decision.get('complete') is True
                         and qa.get('passed') is True and qa.get('media_sha256') == row['media_sha256']
                         and qa.get('recipe_hash') == row['recipe_hash'])
        evaluated = (bound and artifact_ok and row.get('luna_status') not in
                     (None, 'unreviewed', 'not_rendered', 'invalid_artifact', 'unverified_pass_claim')
                     and blind_status in ('pass', 'fix_required', 'reject', 'review'))
        outcomes.append({'candidate_id': vid, 'run_hash': run, 'wave': row.get('wave'),
                         'luna_status': row.get('luna_status'), 'astra_blind_verdict': blind_status,
                         'success': bool(luna_pass and blind_status == 'pass' and vid not in previously_reviewed),
                         'fresh': vid not in previously_reviewed, 'evaluated': bool(evaluated),
                         'false_approval': bool(luna_pass and blind_status in ('fix_required', 'reject')),
                         'escalated': row.get('luna_status') == 'escalated',
                         'explicit_fallback': bool((decision or {}).get('fallback_used') is True
                                                   or 'fallback' in str((decision or {}).get('status', '')).lower()),
                         'artifact_error': artifact_error,
                         'media_sha256': row.get('media_sha256'), 'recipe_hash': row.get('recipe_hash')})
    denominator = len(fresh_rows)
    # Duplicate rows invalidate the result and never inflate successful count.
    successes = len({r['candidate_id'] for r in outcomes if r['success'] and r['candidate_id'] in fresh})
    false_approvals = sum(r['false_approval'] for r in outcomes)
    all_evaluated = (len(outcomes) == denominator and set(row_ids) == fresh
                     and len(set(row_ids)) == len(row_ids) and all(r['evaluated'] for r in outcomes))
    check('all_selected_evaluated', all_evaluated, 'Every selected held-out clip needs both valid Luna and blind Astra evidence.')
    # Exact integer comparison: 14/15 cannot round up to 95%.
    target_fraction = denominator > 0 and successes * 100 >= 95 * denominator
    check('at_least_95_percent', target_fraction, f'{successes}/{denominator} successful unchanged hash-bound clips; target >=95%.')
    check('zero_false_approvals', false_approvals == 0, f'{false_approvals} definite Luna false approvals.')
    return {'schema_version': 'snippy-calibration-goal-v1', 'created_at': audit.now(),
            'target_met': not errors, 'exit_code': 0 if not errors else 1, 'target_fraction': TARGET,
            'successful_clips': successes, 'denominator': denominator,
            'success_fraction': successes / denominator if denominator else None,
            'all_selected_evaluated': all_evaluated, 'false_approvals': false_approvals,
            'escalations': sum(r['escalated'] for r in outcomes),
            'explicit_fallbacks': sum(r['explicit_fallback'] for r in outcomes),
            'fallback_reporting': 'Counts explicit fallback_used/status signals only; unrecorded manual interventions are not inferred.',
            'unreviewed_or_invalid': sum(not r['evaluated'] for r in outcomes) + len(fresh - set(row_ids)),
            'cap': {'original_pilots': 5, 'calibration_selected': len(candidates),
                    'total_selected': 5 + len(candidates), 'maximum': 30, 'unique_calibration_ids': len(set(ids))},
            'selected_pipelines': selected_metadata, 'checks': checks, 'errors': errors, 'clips': outcomes,
            'previously_reviewed_candidate_ids': previously_reviewed,
            'warnings': ['Small sample: empirical success on these clips is not proof of a 95% population success rate.',
                         'Fresh validation is 15 clips, not 20; wave 1 is training and the original 5 pilots are excluded.',
                         'Same-clip reruns are repeated measurements, never additional fresh candidates.',
                         'Freshness audit covers supplied comparison history; retain prior runs in calibration.json rather than hiding them.']}


def save_report(result, output):
    output = Path(output)
    audit.atomic(output / 'goal-verification.json', result)
    lines = ['# Calibration goal verification', '',
             'PASS' if result['target_met'] else 'FAIL', '',
             f"Unchanged hash-bound successes: {result['successful_clips']}/{result['denominator']}; target ≥95%.",
             f"False approvals: {result['false_approvals']}; escalations: {result['escalations']}; explicit fallbacks: {result['explicit_fallbacks']}.",
             f"Selected total: {result['cap']['total_selected']}/30 (including original five).", '',
             '| Check | Result | Evidence |', '|---|---|---|']
    for check in result['checks']:
        detail = check['detail'].replace('|', '\\|').replace('\n', ' ')
        lines.append(f"| {check['check']} | {'PASS' if check['passed'] else 'FAIL'} | {detail} |")
    lines += ['', *result['warnings'], '', result['fallback_reporting']]
    (output / 'goal-verification.md').write_text('\n'.join(lines) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--calibration', type=Path, required=True)
    parser.add_argument('--pipelines', type=Path, nargs='+', required=True,
                        help='Explicit files for selected held-out runs/version; never directories or training runs')
    parser.add_argument('--output', type=Path, help='Defaults to the manifest directory')
    args = parser.parse_args()
    try:
        pairs = [(path, calibration_tools.read(path)) for path in args.pipelines]
        result = check_goal(calibration_tools.read(args.manifest), calibration_tools.read(args.calibration), pairs)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f'Goal not verified: invalid input: {exc}\n')
    save_report(result, args.output or args.manifest.parent)
    print(json.dumps({k: result[k] for k in ('target_met', 'successful_clips', 'denominator', 'false_approvals', 'exit_code')}, indent=2))
    raise SystemExit(result['exit_code'])


if __name__ == '__main__':
    main()
