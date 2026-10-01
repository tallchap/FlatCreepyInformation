#!/usr/bin/env python3
"""Freeze one exact production subset and its drained-owner reconciliation."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import shutil

import audit
from production import process_alive, runner_lock
from luna_batch_qa import MAX_PASSES


TERMINAL = {'published', 'already_published', 'awaiting_astra', 'failed'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def load_ids(path, expected):
    raw = Path(path).read_bytes()
    if (sha(path) != expected or not raw or raw.startswith(b'\xef\xbb\xbf')
            or b'\r' in raw or not raw.endswith(b'\n')):
        raise ValueError('Selected ID file bytes/hash are invalid')
    ids = raw[:-1].decode('ascii').split('\n')
    if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[A-Za-z0-9_-]{11}', vid) for vid in ids):
        raise ValueError('Selected IDs are duplicated or invalid')
    return raw, ids


def prepare(root, continuation, ids_source, job_id, expected_ids_sha, expected_manifest_sha,
            expected_cull_sha, old_continuation):
    root, continuation = Path(root).resolve(), Path(continuation).resolve()
    old_continuation = Path(old_continuation).resolve()
    continuation.mkdir(parents=True, exist_ok=True)
    if any(continuation.iterdir()):
        raise ValueError('Fixed-subset continuation directory must be empty on first freeze')
    raw_ids, ids = load_ids(ids_source, expected_ids_sha)
    manifest_path, cull_path = root / 'input/manifest.json', root / 'input/culled-ids.json'
    if sha(manifest_path) != expected_manifest_sha or sha(cull_path) != expected_cull_sha:
        raise ValueError('Frozen manifest or cull file hash changed')
    manifest, culls = load(manifest_path), load(cull_path)
    manifest_ids = {row['candidate_id'] for row in manifest['candidates']}
    culled_ids = {row['video_id'] if isinstance(row, dict) else row for row in culls}
    if len(ids) != 340 or len(manifest_ids) != 1644 or len(culls) != 915 or set(ids) - manifest_ids or set(ids) & culled_ids:
        raise ValueError('Exact 340 membership or cull exclusion failed')

    retirement = load(old_continuation / 'retirement-receipt.json')
    archive = Path(retirement['archive_manifest_path']).parent
    status_path, control_path = archive / 'status.json', archive / 'control-state.json'
    live_auth, live_admission = old_continuation / 'authorization.json', old_continuation / 'admission-approved.json'
    status, control = load(status_path), load(control_path)
    if (retirement.get('retired_job_id') != 'SNIPPY-LUNA-CONTINUE-20261001'
            or retirement.get('superseded_by') != job_id or retirement.get('supervisor_alive') is not False
            or retirement.get('process_locks_were_free') is not True
            or load(live_auth).get('scope') != 'revoked' or load(live_auth).get('superseded_by') != job_id
            or load(live_admission).get('approved') is not False or load(live_admission).get('superseded_by') != job_id
            or process_alive(status.get('supervisor_pid'))):
        raise ValueError('Broad owner retirement is not durable')
    with runner_lock(root / 'runner.lock'), runner_lock(old_continuation / 'supervisor.lock'), \
            runner_lock(root / 'production-owner.lock'):
        pass

    selected_records, counts = {}, Counter()
    for vid in ids:
        path = root / 'records' / f'{vid}.json'
        if path.exists():
            row = load(path)
            selected_records[vid] = {'status': row.get('status'), 'record_sha256': sha(path),
                                     'record_bytes': path.stat().st_size, 'path': str(path)}
            counts[row.get('status', 'unknown')] += 1
        else:
            counts['unadmitted'] += 1
    selected_set = set(ids)
    pending = {vid for vid in ids if selected_records.get(vid, {}).get('status') not in TERMINAL}
    mixed, pending_collisions = [], []
    for plan_path in sorted((root / 'batches').glob('*/batch-plan.json')):
        plan = load(plan_path)
        slot = plan.get('slot_candidate_ids', [])
        overlap = [vid for vid in ids if vid in slot]
        if not overlap:
            continue
        outside = [vid for vid in slot if vid not in selected_set]
        item = {'batch_name': plan_path.parent.name, 'batch_plan_path': str(plan_path),
                'batch_plan_sha256': sha(plan_path), 'selected_ids': overlap, 'outside_ids': outside,
                'paid_candidate_ids': plan.get('candidate_ids', [])}
        mixed.append(item)
        for vid in overlap:
            if vid in pending and outside:
                pending_collisions.append({'candidate_id': vid, **item})

    original_records = list((root / 'records').glob('*.json'))
    outside_hashes = {path.stem: sha(path) for path in original_records if path.stem not in selected_set}
    preflight = {'schema_version': 'snippy-fixed-subset-preflight-v1', 'generated_at': audit.now(),
        'job_id': job_id, 'selected_ids_sha256': expected_ids_sha, 'candidate_count': len(ids),
        'manifest_sha256': expected_manifest_sha, 'manifest_candidate_count': len(manifest_ids),
        'culled_ids_sha256': expected_cull_sha, 'culled_count': len(culls), 'culled_overlap': [],
        'counts': dict(counts), 'terminal': sum(counts[state] for state in TERMINAL),
        'pending': len(pending), 'selected_records': selected_records,
        'out_of_scope_existing_record_count': len(outside_hashes),
        'out_of_scope_existing_record_sha256': outside_hashes,
        'out_of_scope_absent_record_count': len(manifest_ids - selected_set - set(outside_hashes)),
        'mixed_historical_batches': mixed, 'pending_mixed_collisions': pending_collisions,
        'mixed_collision_policy': 'Hold selected pending members; never replay, shrink, or regroup a paid mixed batch.',
        'broad_owner': {'job_id': status.get('job_id'), 'status_path': str(status_path),
            'status_sha256': sha(status_path), 'control_state_path': str(control_path),
            'control_state_sha256': sha(control_path), 'phase': status.get('phase'),
            'desired': status.get('desired'), 'own_children_alive': status.get('own_children_alive'),
            'runner_pid': status.get('runner_pid'), 'asr_pid': status.get('asr_pid'),
            'asr_launcher_pid': status.get('asr_launcher_pid'), 'supervisor_pid': status.get('supervisor_pid'),
            'supervisor_alive': False, 'retirement_receipt_path': str(old_continuation / 'retirement-receipt.json'),
            'retirement_receipt_sha256': sha(old_continuation / 'retirement-receipt.json'),
            'live_authorization_path': str(live_auth), 'live_authorization_sha256': sha(live_auth),
            'live_admission_path': str(live_admission), 'live_admission_sha256': sha(live_admission),
            'process_locks_free': True}}
    audit.atomic(continuation / 'preflight-reconciliation.json', preflight)
    (continuation / 'selected-ids.txt').write_bytes(raw_ids)
    pause_id = control.get('last_applied_order', [None, None, None])[-1]
    authorization = {'schema_version': 'snippy-fixed-subset-authorization-v1', 'job_id': job_id,
        'created_at': audit.now(), 'scope': 'fixed_subset_frozen_manifest', 'codex_on_shadow': True,
        'base_commit': 'a30011e612869d90d107ded4ea18f9dacc0ab666', 'selected_ids_file': 'selected-ids.txt',
        'selected_ids_sha256': expected_ids_sha, 'candidate_count': len(ids),
        'manifest_sha256': expected_manifest_sha, 'original_manifest_sha256': expected_manifest_sha,
        'culled_ids_sha256': expected_cull_sha, 'preflight_sha256': sha(continuation / 'preflight-reconciliation.json'),
        'recoverable_failed_ids': [], 'recovery_proofs': {}, 'max_batch_members': 5, 'batch_workers': 2,
        'render_slots': 2, 'asr_slots': 1, 'publication_writers': 1, 'max_passes': MAX_PASSES,
        'min_release_confidence': .95, 'paid_astra_authorized': False, 'preserve_deferred_astra': True,
        'broad_owner_handoff': {'job_id': status.get('job_id'), 'status_path': str(status_path),
            'status_sha256': sha(status_path), 'control_state_path': str(control_path),
            'control_state_sha256': sha(control_path), 'required_pause_control_id': pause_id,
            'supervisor_pid': status.get('supervisor_pid'),
            'retirement_receipt_path': str(old_continuation / 'retirement-receipt.json'),
            'retirement_receipt_sha256': sha(old_continuation / 'retirement-receipt.json'),
            'live_authorization_path': str(live_auth), 'live_authorization_sha256': sha(live_auth),
            'live_admission_path': str(live_admission), 'live_admission_sha256': sha(live_admission)}}
    authorization['authorization_sha256'] = audit.digest(authorization)
    audit.atomic(continuation / 'authorization.json', authorization)
    lines = ['# Fixed 340 preflight reconciliation', '',
             f"Selection: {len(ids)} unique IDs, SHA-256 `{expected_ids_sha}`.",
             f"Partition: `{json.dumps(dict(counts), sort_keys=True)}`; pending={len(pending)}.",
             f"Manifest/culls: 1644 / 915; selected-cull overlap=0.",
             f"Broad owner: paused, drained, PID {status.get('supervisor_pid')} dead, authorization revoked.",
             f"Pending mixed paid-batch collisions: {len(pending_collisions)}; all are preflight holds."]
    (continuation / 'preflight-reconciliation.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return {'authorization_path': str(continuation / 'authorization.json'),
            'authorization_file_sha256': sha(continuation / 'authorization.json'),
            'authorization_sha256': authorization['authorization_sha256'],
            'preflight_sha256': authorization['preflight_sha256'], 'counts': dict(counts),
            'pending_mixed_collisions': [row['candidate_id'] for row in pending_collisions]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--continuation', type=Path, required=True)
    parser.add_argument('--ids-source', type=Path, required=True)
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--expected-ids-sha', required=True)
    parser.add_argument('--expected-manifest-sha', required=True)
    parser.add_argument('--expected-cull-sha', required=True)
    parser.add_argument('--old-continuation', type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(prepare(args.root, args.continuation, args.ids_source, args.job_id,
        args.expected_ids_sha, args.expected_manifest_sha, args.expected_cull_sha,
        args.old_continuation), indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
