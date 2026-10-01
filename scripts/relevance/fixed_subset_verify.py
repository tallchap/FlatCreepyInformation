#!/usr/bin/env python3
"""Offline final verifier for a hash-bound fixed production subset.

This never calls a model, cloud API, or media service.  It proves the exact
authorized partition, publication receipts/artifact bindings, Luna-only call
ledger, and byte-for-byte preservation of every out-of-scope ledger entry.
"""
import argparse
from collections import Counter
import csv
import json
from pathlib import Path
import re

import audit
from luna_batch_qa import release_gate_passed
from production import validate_fixed_subset_protection_cover, validate_preflight_hold_receipt
from fixed_subset_checkpoint import delivery_state
from production_report import Reporter, sha


TERMINAL = {'published', 'already_published', 'awaiting_astra', 'failed'}
PUBLISHED = {'published', 'already_published'}


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def checked_hash(path, expected, errors, code, **detail):
    path = Path(path)
    try:
        actual = sha(path)
    except OSError as exc:
        errors.append({'code': code, 'path': str(path), 'error_type': type(exc).__name__, **detail})
        return False
    if actual != expected:
        errors.append({'code': code, 'path': str(path), 'expected': expected, 'actual': actual, **detail})
        return False
    return True


def verify(root, continuation):
    root, continuation = Path(root).resolve(), Path(continuation).resolve()
    auth_path, plan_path = continuation / 'authorization.json', continuation / 'continuation-plan.json'
    auth, plan = load(auth_path), load(plan_path)
    errors = []
    auth_unsigned = {key: value for key, value in auth.items() if key != 'authorization_sha256'}
    plan_unsigned = {key: value for key, value in plan.items() if key != 'plan_sha256'}
    selected_name = auth.get('selected_ids_file')
    if (auth.get('schema_version') != 'snippy-fixed-subset-authorization-v1'
            or auth.get('scope') != 'fixed_subset_frozen_manifest'
            or auth.get('authorization_sha256') != audit.digest(auth_unsigned)
            or auth.get('candidate_count') != 340
            or auth.get('paid_astra_authorized') is not False
            or auth.get('max_batch_members') != 5 or auth.get('batch_workers') != 2
            or auth.get('render_slots') != 2 or auth.get('asr_slots') != 1
            or auth.get('publication_writers') != 1
            or auth.get('min_release_confidence') != .95 or auth.get('max_passes') != 5
            or not isinstance(selected_name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', selected_name)):
        errors.append({'code': 'fixed_subset_authorization_invalid'})
        selected = []
    else:
        selected_path = (continuation / selected_name).resolve()
        try:
            raw = selected_path.read_bytes()
            selected = raw[:-1].decode('ascii').split('\n') if raw.endswith(b'\n') else []
            if (raw.startswith(b'\xef\xbb\xbf') or b'\r' in raw or not raw.endswith(b'\n')
                    or sha(selected_path) != auth.get('selected_ids_sha256')
                    or len(selected) != len(set(selected)) or len(selected) != auth.get('candidate_count')
                    or any(not re.fullmatch(r'[A-Za-z0-9_-]{11}', vid) for vid in selected)):
                raise ValueError('selected ID bytes/count/hash invalid')
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            errors.append({'code': 'selected_ids_invalid', 'error': str(exc)})
            selected = []
    if (plan.get('schema_version') != 'snippy-fixed-subset-plan-v1'
            or plan.get('continuation_id') != auth.get('job_id')
            or plan.get('plan_sha256') != audit.digest(plan_unsigned)
            or plan.get('authorization_sha256') != sha(auth_path)
            or plan.get('authorized_candidate_ids') != selected
            or plan.get('authorized_candidate_count') != len(selected)
            or plan.get('selected_ids_sha256') != auth.get('selected_ids_sha256')):
        errors.append({'code': 'fixed_subset_plan_invalid'})

    manifest_path, cull_path = root / 'input/manifest.json', root / 'input/culled-ids.json'
    manifest, culls = load(manifest_path), load(cull_path)
    manifest_ids = [row['candidate_id'] for row in manifest.get('candidates', [])]
    culled_ids = {row['video_id'] if isinstance(row, dict) else row for row in culls}
    if (len(manifest_ids) != 1644 or len(set(manifest_ids)) != 1644 or len(culls) != 915
            or auth.get('manifest_sha256') != sha(manifest_path)
            or auth.get('original_manifest_sha256') != sha(manifest_path)
            or auth.get('culled_ids_sha256') != sha(cull_path)
            or set(selected) - set(manifest_ids) or set(selected) & culled_ids):
        errors.append({'code': 'fixed_subset_inventory_or_cull_invalid'})

    selected_set, manifest_set = set(selected), set(manifest_ids)
    protected_map = plan.get('protected_record_sha256', {})
    absent_rows = plan.get('protected_absent_ids', [])
    safe_protected = protected_map if isinstance(protected_map, dict) else {}
    safe_absent = absent_rows if isinstance(absent_rows, list) else []
    current_record_ids = {path.stem for path in (root / 'records').glob('*.json')}
    try:
        cover = validate_fixed_subset_protection_cover(
            plan, manifest_set, selected_set, current_record_ids)
    except (ValueError, TypeError) as exc:
        cover = {'protected_existing_outside_ids': set(safe_protected) - selected_set,
                 'protected_absent_ids': set(safe_absent)}
        errors.append({'code': 'protected_outsider_cover_invalid',
                       'error_type': type(exc).__name__, 'error': str(exc)})
    outside_manifest_records = sorted(current_record_ids - manifest_set)
    if outside_manifest_records:
        errors.append({'code': 'current_record_outside_manifest',
                       'candidate_ids': outside_manifest_records})
    unauthorized_records = sorted(
        current_record_ids - selected_set - set(cover['protected_existing_outside_ids']))
    if unauthorized_records:
        errors.append({'code': 'current_record_not_authorized_or_protected',
                       'candidate_ids': unauthorized_records})

    for vid, expected in safe_protected.items():
        checked_hash(root / 'records' / f'{vid}.json', expected, errors, 'protected_record_changed', candidate_id=vid)
    for vid in safe_absent:
        if (root / 'records' / f'{vid}.json').exists():
            errors.append({'code': 'protected_outsider_record_appeared', 'candidate_id': vid})
    for relative, expected in plan.get('preserved_file_sha256', {}).items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root):
            errors.append({'code': 'preserved_path_escaped_root', 'path': relative})
        else:
            checked_hash(path, expected, errors, 'preserved_plan_or_checkpoint_changed')

    try:
        preflight = validate_preflight_hold_receipt(
            root, continuation, plan, required=bool(plan.get('preflight_holds')),
            verify_mixed_inventory=True)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        preflight = {}
        errors.append({'code': 'preflight_hold_disposition_invalid',
                       'error_type': type(exc).__name__, 'error': str(exc)})

    resolver = Reporter(root, verify_media=False)
    rows = []
    for vid in selected:
        path = root / 'records' / f'{vid}.json'
        try:
            row = load(path)
        except (OSError, ValueError) as exc:
            row = {'candidate_id': vid, 'status': 'missing'}
            errors.append({'code': 'selected_record_missing_or_invalid', 'candidate_id': vid,
                           'error_type': type(exc).__name__})
        source_status = row.get('status')
        status = preflight.get(vid, {}).get('effective_status', source_status)
        reason = preflight.get(vid, {}).get('reason') or row.get('reason') or row.get('error')
        disposition = {'candidate_id': vid, 'status': status, 'reason': reason,
                       'source_record_status': source_status, 'record_path': str(path),
                       'record_sha256': sha(path) if path.exists() else None}
        if row.get('candidate_id') != vid or status not in TERMINAL:
            errors.append({'code': 'selected_candidate_nonterminal', 'candidate_id': vid, 'status': status})
        elif status in PUBLISHED:
            receipt_path = resolver.resolve(row.get('publication_receipt', '__missing__'))
            try:
                receipt = load(receipt_path)
                if receipt.get('passed') is not True or receipt.get('video_id') != vid:
                    raise ValueError('publication receipt identity/passed flag invalid')
                disposition.update(publication_receipt=str(receipt_path), snippet_id=receipt.get('snippet_id'),
                                   gcs_url=receipt.get('gcs_url'), publication_receipt_sha256=sha(receipt_path))
                if status == 'published':
                    directory = resolver.resolve(row.get('final_directory', '__missing__'))
                    recipe, qa = load(directory / 'recipe.json'), load(directory / 'final-qa.json')
                    media_hash = sha(directory / 'clip.mp4')
                    required = ('picture_verified', 'dialogue_verified', 'boundaries_verified', 'duration_verified')
                    if (media_hash != receipt.get('media_sha256') or audit.digest(recipe) != receipt.get('recipe_hash')
                            or qa.get('passed') is not True or qa.get('media_sha256') != media_hash
                            or qa.get('recipe_hash') != audit.digest(recipe)
                            or not all(qa.get('checks', {}).get(key) is True for key in required)
                            or (str(qa.get('reviewer', '')).startswith('gpt-6-luna')
                                and not release_gate_passed(qa.get('release_gate'), .95))):
                        raise ValueError('published media/final-QA binding invalid')
                    disposition.update(media_path=str(directory / 'clip.mp4'), media_sha256=media_hash,
                                       recipe_hash=audit.digest(recipe), final_qa_sha256=sha(directory / 'final-qa.json'))
            except (OSError, ValueError, KeyError, TypeError) as exc:
                errors.append({'code': 'selected_publication_invalid', 'candidate_id': vid, 'error': str(exc)})
        elif status == 'awaiting_astra':
            evidence = (preflight.get(vid, {}).get('packet_path')
                        or row.get('handoff') or row.get('packet_path'))
            evidence_path = resolver.resolve(evidence or '__missing__')
            if not reason or not evidence_path.is_file():
                errors.append({'code': 'selected_astra_evidence_missing', 'candidate_id': vid})
            else:
                disposition.update(astra_evidence_path=str(evidence_path), astra_evidence_sha256=sha(evidence_path))
            if row.get('directory'):
                media = resolver.resolve(row['directory']) / 'clip.mp4'
                if media.is_file():
                    disposition.update(media_path=str(media), media_sha256=sha(media))
        elif status == 'failed' and not reason:
            errors.append({'code': 'selected_failure_reason_missing', 'candidate_id': vid})
        rows.append(disposition)

    # The corpus-wide immutable call ledger predates this subset.  It still must
    # contain Luna only and no unresolved charge; selected work cannot hide a
    # conflicting provider receipt elsewhere in the same production root.
    api_reporter = Reporter(root, verify_media=False)
    api = api_reporter.api_accounting()
    errors.extend(api_reporter.errors)
    if api.get('unknown_charge_requests'):
        errors.append({'code': 'unknown_charge_requests_unresolved', 'requests': api['unknown_charge_requests']})
    if api.get('unpriced_response_ids'):
        errors.append({'code': 'unpriced_response_usage', 'response_ids': api['unpriced_response_ids']})
    non_luna = [row for row in api.get('responses', []) if not str(row.get('model', '')).startswith('gpt-6-luna')]
    if non_luna:
        errors.append({'code': 'non_luna_model_receipts', 'response_ids': [row.get('response_id') for row in non_luna]})
    retries = sum(max([state.get('attempt', 1) for state in request.get('call_states', [])] or [1]) - 1
                  for request in api.get('requests', []))
    counts = dict(Counter(row['status'] for row in rows))
    fallback_ids = sorted(row['candidate_id'] for row in rows
                          if row['status'] in {'awaiting_astra', 'failed'})
    delivered_fallback_ids = []
    try:
        delivery = delivery_state(continuation, auth,
                                  load(continuation / 'preflight-reconciliation.json'), selected_set)
        delivered_fallback_ids = sorted(delivery.get('delivered_fallback_ids', []))
        missing_deliveries = sorted(set(fallback_ids) - set(delivered_fallback_ids))
        if missing_deliveries:
            errors.append({'code': 'fallback_evidence_not_delivered',
                           'candidate_ids': missing_deliveries})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append({'code': 'fallback_delivery_state_invalid',
                       'error_type': type(exc).__name__, 'error': str(exc)})
    outsider_existing = set(safe_protected) - selected_set
    report = {'schema_version': 'snippy-fixed-subset-final-verification-v1', 'generated_at': audit.now(),
              'job_id': auth.get('job_id'), 'root': str(root), 'continuation_dir': str(continuation),
              'authorization_file_sha256': sha(auth_path), 'authorization_sha256': auth.get('authorization_sha256'),
              'continuation_plan_file_sha256': sha(plan_path), 'continuation_plan_sha256': plan.get('plan_sha256'),
              'selected_ids_sha256': auth.get('selected_ids_sha256'), 'requested': len(selected),
              'covered': sum(counts.get(status, 0) for status in TERMINAL),
              'remaining': sum(count for status, count in counts.items() if status not in TERMINAL),
              'disposition_counts': counts, 'rows': rows,
              'out_of_scope_existing_record_count': len(outsider_existing),
              'out_of_scope_absent_record_count': len(safe_absent),
              'out_of_scope_unchanged': not any(error['code'] in {
                  'protected_record_changed', 'protected_outsider_record_appeared',
                  'protected_outsider_cover_invalid', 'current_record_outside_manifest',
                  'current_record_not_authorized_or_protected'} for error in errors),
              'unique_luna_response_count': len(api.get('responses', [])),
              'known_luna_cost_usd': api.get('luna_cost_usd', 0), 'retry_count': retries,
              'unknown_charge_requests': api.get('unknown_charge_requests', []),
              'no_remote_astra_calls': not non_luna, 'fallback_ids': fallback_ids,
              'delivered_fallback_ids': delivered_fallback_ids,
              'errors': errors, 'passed': not errors}
    audit.atomic(continuation / 'final-verification.json', report)
    fields = ['candidate_id', 'status', 'reason', 'record_sha256', 'snippet_id', 'gcs_url',
              'publication_receipt_sha256', 'astra_evidence_sha256', 'media_sha256', 'recipe_hash']
    with (continuation / 'final-dispositions.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)
    lines = ['# Fixed-subset continuation verification', '', f"PASS: {report['passed']}",
             f"{report['covered']}/{report['requested']} terminal; {report['remaining']} pending.",
             f"Dispositions: {json.dumps(counts, sort_keys=True)}.",
             f"Out-of-scope unchanged: {report['out_of_scope_unchanged']}.",
             f"Known Luna usage: ${report['known_luna_cost_usd']:.9f}; retries: {retries}; "
             f"unknown-charge requests: {len(report['unknown_charge_requests'])}.",
             '', '## Errors', '', json.dumps(errors, indent=2)]
    (continuation / 'final-verification.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--continuation-dir', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = verify(args.root, args.continuation_dir)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        report = {'schema_version': 'snippy-fixed-subset-final-verification-v1',
                  'generated_at': audit.now(), 'passed': False,
                  'errors': [{'code': 'verification_exception', 'error_type': type(exc).__name__, 'error': str(exc)}]}
        audit.atomic(args.continuation_dir / 'final-verification.json', report)
    print(json.dumps({key: report.get(key) for key in
                      ('passed', 'covered', 'remaining', 'disposition_counts', 'known_luna_cost_usd', 'retry_count')}))
    return 0 if report.get('passed') else 1


if __name__ == '__main__':
    raise SystemExit(main())
