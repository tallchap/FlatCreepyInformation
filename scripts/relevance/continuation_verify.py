#!/usr/bin/env python3
"""Final offline continuation verifier and safe raw-response export.

Source failures and deferred Astra candidates are explicit terminal dispositions;
pending work, changed immutable receipts, unknown charges, or non-Luna calls fail.
No API, model, publication, or media processing is performed here.
"""
import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import re

import audit
from production_report import Reporter, DISPOSED, PUBLISHED, FAILED, sha


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def require_hash(path, expected, errors, code):
    path = Path(path)
    try:
        actual = sha(path)
    except OSError as exc:
        errors.append({'code': code, 'path': str(path), 'error_type': type(exc).__name__})
        return False
    if actual != expected:
        errors.append({'code': code, 'path': str(path), 'expected': expected, 'actual': actual})
        return False
    return True


def response_model_errors(root):
    errors = []
    for base in (root / 'batches', root / 'mac-checkpoint/batches'):
        for pattern in ('request.json', 'response.json'):
            for path in base.rglob(pattern):
                try:
                    model = load(path).get('model')
                    if not isinstance(model, str) or not model.startswith('gpt-6-luna'):
                        errors.append({'code': 'non_luna_model_receipt', 'path': str(path), 'model': model})
                except (OSError, ValueError, AttributeError) as exc:
                    errors.append({'code': 'invalid_model_receipt', 'path': str(path), 'error_type': type(exc).__name__})
    return errors


def copy_raw_responses(api, destination):
    """Copy only validated response JSON. Never traverse/copy request directories."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    items, errors = [], []
    seen = {}
    for row in api.get('responses', []):
        rid = row.get('response_id')
        paths = row.get('response_paths') or []
        if not rid or not paths:
            errors.append({'code': 'raw_response_identity_missing'})
            continue
        source = Path(paths[0])
        try:
            raw_bytes = source.read_bytes()
            raw = json.loads(raw_bytes)
            # These are provider Responses objects. Secret-bearing arbitrary JSON
            # or requests are never accepted merely because their filename matches.
            if (source.name != 'response.json' or raw.get('id') != rid
                    or not str(raw.get('model', '')).startswith('gpt-6-luna')
                    or not isinstance(raw.get('usage'), dict)
                    or audit.digest(raw) != row.get('response_sha256')):
                raise ValueError('Response identity or content receipt mismatch')
            if re.search(rb'(?:sk-(?:proj-|admin-|ant-)[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA )?PRIVATE KEY-----)', raw_bytes):
                raise ValueError('Credential-like content found in response; do not export')
            content_hash = hashlib.sha256(raw_bytes).hexdigest()
            if rid in seen and seen[rid] != content_hash:
                raise ValueError('Conflicting raw response ID')
            seen[rid] = content_hash
            target = destination / (content_hash + '.json')
            if target.exists() and target.read_bytes() != raw_bytes:
                raise ValueError('Immutable response export changed')
            if not target.exists():
                target.write_bytes(raw_bytes)
            items.append({'response_id': rid, 'source_path': str(source), 'path': str(target),
                          'sha256': content_hash, 'bytes': len(raw_bytes),
                          'usage_derived_cost_usd': row.get('usage_derived_cost_usd')})
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            errors.append({'code': 'raw_response_export_failed', 'response_id': rid,
                           'path': str(source), 'error_type': type(exc).__name__, 'error': str(exc)})
    audit.atomic(destination / 'index.json', {'schema_version': 'snippy-raw-response-export-v1',
                                            'responses': items, 'errors': errors})
    return items, errors


def baseline_checks(root, continuation, baseline, authorization):
    errors = []
    if baseline.get('passed') is not True or baseline.get('candidate_count') != 1644:
        errors.append({'code': 'baseline_preflight_not_passed'})
    manifest_receipt = baseline.get('input_manifest', {})
    require_hash(root / 'input/manifest.json', manifest_receipt.get('sha256'), errors, 'input_manifest_changed')
    checkpoint = Path(baseline['acknowledged_checkpoint'])
    require_hash(checkpoint / 'manifest.json', baseline.get('checkpoint_manifest', {}).get('sha256'), errors, 'checkpoint_manifest_changed')
    cp_manifest = load(checkpoint / 'manifest.json')
    frozen = {}
    paid_ids = set()
    for item in cp_manifest['files']:
        relative = Path(item['path'])
        parts = relative.parts
        if not parts or parts[0] != 'artifacts':
            continue
        live = root.joinpath(*parts[1:])
        # All transferred inputs/Mac checkpoint artifacts and old paid membership
        # plans remain immutable. Existing mutable per-round ledgers may append.
        if (len(parts) > 1 and parts[1] in ('input', 'mac-checkpoint')) or relative.name in ('experiment-plan.json', 'stream-plan.json', 'batch-plan.json'):
            frozen[str(live)] = item['sha256']
        if relative.name == 'batch-plan.json':
            paid_ids.update(load(checkpoint / relative).get('candidate_ids', []))
    for path, expected in frozen.items():
        require_hash(path, expected, errors, 'immutable_input_or_plan_changed')
    # Response bodies were deliberately separate from the compact manifest.
    usage = load(checkpoint / 'response-usage.json')
    reporter = Reporter(root)
    for row in usage['responses']:
        require_hash(reporter.resolve(row['source_path']), row['response_sha256'], errors, 'prior_raw_response_changed')

    recoverable = set(authorization.get('recoverable_failed_ids', []))
    evidenced = {r['candidate_id'] for r in baseline.get('failure_recovery', [])
                 if r.get('retry_authorized_if_full_gates_rechecked') is True}
    if not recoverable <= evidenced:
        errors.append({'code': 'recovery_not_evidenced_transient_failure', 'candidate_ids': sorted(recoverable - evidenced)})
    if recoverable & paid_ids:
        errors.append({'code': 'recovery_would_regroup_paid_member', 'candidate_ids': sorted(recoverable & paid_ids)})
    backups = authorization.get('recovery_proofs', {})
    for vid in sorted(recoverable):
        expected = baseline['all_prior_record_sha256'].get(vid)
        backup = backups.get(vid, {})
        if backup.get('record_sha256') != expected or not backup.get('backup_path'):
            errors.append({'code': 'recovery_backup_identity_missing', 'candidate_id': vid})
        else:
            require_hash(backup['backup_path'], expected, errors, 'recovery_original_failed_record_changed')
        if backup.get('no_prior_paid_membership') is not True or backup.get('maximum_recovery_attempts') != 1:
            errors.append({'code': 'recovery_authorization_limits_missing', 'candidate_id': vid})
        for proof in backup.get('prior_slot_plans', []):
            require_hash(proof['path'], proof['sha256'], errors, 'recovery_slot_plan_changed')
    if recoverable:
        proof = next((x for x in cp_manifest['files'] if x['path'] == 'artifacts/failure-analysis.json'), None)
        require_hash(root / 'failure-analysis.json', proof.get('sha256') if proof else None, errors, 'recovery_failure_analysis_changed')

    protected = dict(baseline.get('protected', {}))
    for row in baseline.get('failure_recovery', []):
        if row['candidate_id'] not in recoverable:
            protected[row['candidate_id']] = {'record': {'sha256': row['record_sha256']}}
    for vid, value in protected.items():
        require_hash(root / 'records' / (vid + '.json'), value['record']['sha256'], errors, 'protected_prior_record_changed')
        for r in value.get('receipts', {}).values():
            require_hash(r['path'], r['sha256'], errors, 'protected_prior_receipt_changed')
    for path, expected in authorization.get('immutable_files_sha256', {}).items():
        require_hash(path, expected, errors, 'authorization_immutable_file_changed')
    return {'errors': errors, 'protected_record_count': len(protected), 'immutable_file_count': len(frozen),
            'recoverable_failed_ids': sorted(recoverable), 'preserved_prior_response_count': len(usage['responses'])}


def terminal_errors(report):
    errors = []
    coverage = report.get('coverage', [])
    ids = [r.get('candidate_id') for r in coverage]
    if len(ids) != 1644 or len(set(ids)) != 1644:
        errors.append({'code': 'final_coverage_not_exact_1644', 'actual': len(ids)})
    pending = [r['candidate_id'] for r in coverage if r.get('status') not in DISPOSED]
    if pending:
        errors.append({'code': 'nonterminal_candidates_remaining', 'candidate_ids': pending})
    unexplained = [r['candidate_id'] for r in coverage if r.get('status') in FAILED and not r.get('reason')]
    if unexplained:
        errors.append({'code': 'failure_without_explicit_reason', 'candidate_ids': unexplained})
    if report.get('api', {}).get('unknown_charge_requests'):
        errors.append({'code': 'unknown_charge_requests_unresolved',
                       'requests': report['api']['unknown_charge_requests']})
    if report.get('api', {}).get('unpriced_response_ids'):
        errors.append({'code': 'unpriced_response_usage', 'response_ids': report['api']['unpriced_response_ids']})
    return errors


def verify(root, continuation):
    root, continuation = Path(root).resolve(), Path(continuation).resolve()
    authorization_path = continuation / 'authorization.json'
    preflight_path = continuation / 'preflight-reconciliation.json'
    authorization, baseline = load(authorization_path), load(preflight_path)
    errors = []
    require_hash(preflight_path, authorization.get('preflight_sha256'), errors, 'authorized_preflight_changed')
    require_hash(root / 'input/manifest.json', authorization.get('manifest_sha256'), errors, 'authorized_manifest_changed')
    if (authorization.get('job_id') != 'SNIPPY-LUNA-CONTINUE-20261001'
            or authorization.get('candidate_count') != 1644
            or authorization.get('paid_astra_authorized') is not False
            or authorization.get('preserve_deferred_astra') is not True
            or authorization.get('max_passes') != 5
            or authorization.get('min_release_confidence') != .95):
        errors.append({'code': 'authorization_policy_mismatch'})
    baseline_result = baseline_checks(root, continuation, baseline, authorization)
    errors.extend(baseline_result['errors'])
    errors.extend(response_model_errors(root))
    # The existing production verifier validates current media SHA, exact ASR
    # bindings, >=.95 release gate, publication row receipts and Mac preservation.
    production = Reporter(root, verify_media=True).run()
    errors.extend(production['errors'])
    errors.extend(terminal_errors(production))
    status = load(continuation / 'continuation-status.json')
    if status.get('phase') != 'continuation_completed' or not status.get('finished_at'):
        errors.append({'code': 'continuation_not_completed', 'phase': status.get('phase')})
    candidates = load(root / 'input/manifest.json')['candidates']
    culls = load(root / 'input/culled-ids.json')
    overlap = sorted({r['candidate_id'] for r in candidates} & {r['video_id'] for r in culls})
    if len(culls) != 915 or overlap:
        errors.append({'code': 'culled_inventory_or_overlap_failed', 'culled_count': len(culls), 'overlap': overlap})
    exported, export_errors = copy_raw_responses(production['api'], continuation / 'raw-responses')
    errors.extend(export_errors)
    report = {'schema_version': 'snippy-continuation-final-verification-v1', 'generated_at': audit.now(),
              'root': str(root), 'continuation_dir': str(continuation),
              'authorization_sha256': sha(authorization_path), 'baseline_sha256': sha(preflight_path),
              'requested': 1644, 'covered': production['covered'], 'remaining': production['remaining'],
              'stage_counts': production['stage_counts'], 'disposition_counts': production['disposition_counts'],
              'baseline_checks': baseline_result, 'culled_count': len(culls), 'culled_overlap': overlap,
              'known_luna_cost_usd': production['luna_cost_usd'],
              'unique_response_count': production['api']['unique_responses'],
              'unknown_charge_requests': production['api']['unknown_charge_requests'],
              'raw_response_export_count': len(exported), 'raw_response_export_index': str(continuation / 'raw-responses/index.json'),
              'production_report_path': str(root / 'production-report.json'),
              'publication_integrity_passed': production['integrity_passed'],
              'all_terminal': not any(r.get('status') not in DISPOSED for r in production['coverage']),
              'no_astra_api_calls': not any(e['code'] == 'non_luna_model_receipt' for e in errors),
              'errors': errors, 'passed': not errors,
              'limitations': ['Offline receipt verification, not fresh cloud readback. Publication receipts contain the write-time readback proofs.',
                  'Mac media was not transferred; preserved hash-bound checkpoint readback evidence is used.',
                  'Known Luna usage cost excludes unknown charges and is not an invoice.',
                  'Explicit source/operational failures and deferred Astra dispositions are reported; all-published is not claimed.']}
    audit.atomic(continuation / 'final-verification.json', report)
    fields = ['candidate_id', 'lane', 'status', 'disposition', 'reason', 'record_sha256']
    with (continuation / 'final-dispositions.csv').open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows({k: row.get(k) for k in fields} for row in production['coverage'])
    lines = ['# Full continuation verification', '', f"PASS: {report['passed']}",
             f"{report['covered']}/1644 terminal; {report['remaining']} pending.",
             f"Dispositions: {json.dumps(report['stage_counts'], sort_keys=True)}.",
             f"Known Luna cost: ${report['known_luna_cost_usd']:.9f}; {report['unique_response_count']} unique responses.",
             f"Protected prior records: {baseline_result['protected_record_count']}; immutable inputs/plans: {baseline_result['immutable_file_count']}.",
             '', '## Verification errors', '', json.dumps(errors, indent=2), '', '## Scope', '',
             *['- ' + item for item in report['limitations']]]
    (continuation / 'final-verification.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--continuation-dir', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        report = verify(args.root, args.continuation_dir)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        args.continuation_dir.mkdir(parents=True, exist_ok=True)
        report = {'schema_version': 'snippy-continuation-final-verification-v1', 'generated_at': audit.now(),
                  'passed': False, 'errors': [{'code': 'verification_exception', 'error_type': type(exc).__name__, 'error': str(exc)}]}
        audit.atomic(args.continuation_dir / 'final-verification.json', report)
    print(json.dumps({k: report.get(k) for k in ('passed', 'covered', 'remaining', 'stage_counts', 'known_luna_cost_usd', 'unique_response_count')}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
