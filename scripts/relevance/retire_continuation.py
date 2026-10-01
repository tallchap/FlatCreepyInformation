#!/usr/bin/env python3
"""Irreversibly revoke one drained continuation while preserving exact evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

import audit
from production import process_alive, runner_lock


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def retire(continuation, root, superseded_by, expected_authorization, expected_admission,
           expected_status, expected_control, expected_stop):
    continuation, root = Path(continuation).resolve(), Path(root).resolve()
    paths = {'authorization.json': continuation / 'authorization.json',
             'admission-approved.json': continuation / 'admission-approved.json',
             'status.json': continuation / 'status.json',
             'control-state.json': continuation / 'control-state.json',
             'STOP.json': root / 'STOP.json'}
    expected = {'authorization.json': expected_authorization, 'admission-approved.json': expected_admission,
                'status.json': expected_status, 'control-state.json': expected_control, 'STOP.json': expected_stop}
    if any(sha(path) != expected[name] for name, path in paths.items()):
        raise ValueError('Broad continuation evidence changed before retirement')
    status, control = load(paths['status.json']), load(paths['control-state.json'])
    runner = status.get('runner_status') or {}
    if (status.get('phase') != 'paused' or status.get('desired') != 'paused'
            or status.get('own_children_alive') is not False
            or any(status.get(key) is not None for key in ('runner_pid', 'asr_pid', 'asr_launcher_pid'))
            or runner.get('active_batches') not in (None, []) or runner.get('active_ids') not in (None, [])
            or control.get('desired') != 'paused' or process_alive(status.get('supervisor_pid'))):
        raise ValueError('Broad continuation is not paused, drained, and stopped')
    # Prove both historical process locks and the new root owner lock are free.
    with runner_lock(root / 'runner.lock'), runner_lock(continuation / 'supervisor.lock'), \
            runner_lock(root / 'production-owner.lock'):
        archive = continuation / 'retirement-evidence' / ('superseded-by-' + superseded_by)
        archive.mkdir(parents=True, exist_ok=False)
        entries = []
        for name, source in paths.items():
            target = archive / name
            shutil.copy2(source, target)
            entries.append({'name': name, 'source_path': str(source), 'path': str(target),
                            'size': target.stat().st_size, 'sha256': sha(target)})
        manifest = {'schema_version': 'snippy-continuation-retirement-archive-v1',
                    'retired_job_id': status.get('job_id'), 'superseded_by': superseded_by,
                    'created_at': audit.now(), 'files': entries}
        manifest['manifest_sha256'] = audit.digest(manifest)
        audit.atomic(archive / 'archive-manifest.json', manifest)
        authorization_marker = {'schema_version': 'snippy-continuation-revoked-v1',
            'job_id': status.get('job_id'), 'scope': 'revoked', 'codex_on_shadow': True,
            'approved': False, 'superseded_by': superseded_by, 'retired_at': audit.now(),
            'reason': 'Broad all-manifest authorization retired after verified paused drain; restart forbidden.',
            'original_sha256': expected_authorization, 'archive_manifest_path': str(archive / 'archive-manifest.json'),
            'archive_manifest_file_sha256': sha(archive / 'archive-manifest.json')}
        admission_marker = {'schema_version': 'snippy-admission-revoked-v1', 'approved': False,
            'job_id': status.get('job_id'), 'superseded_by': superseded_by, 'retired_at': audit.now(),
            'reason': 'Continuation authorization revoked after verified paused drain.',
            'original_sha256': expected_admission, 'archive_manifest_path': str(archive / 'archive-manifest.json'),
            'archive_manifest_file_sha256': sha(archive / 'archive-manifest.json')}
        audit.atomic(paths['authorization.json'], authorization_marker)
        audit.atomic(paths['admission-approved.json'], admission_marker)
        receipt = {'schema_version': 'snippy-continuation-retirement-v1', 'retired_at': audit.now(),
                   'retired_job_id': status.get('job_id'), 'superseded_by': superseded_by,
                   'archive_manifest_path': str(archive / 'archive-manifest.json'),
                   'archive_manifest_file_sha256': sha(archive / 'archive-manifest.json'),
                   'live_authorization_sha256': sha(paths['authorization.json']),
                   'live_admission_sha256': sha(paths['admission-approved.json']),
                   'stop_sha256': sha(paths['STOP.json']), 'supervisor_pid': status.get('supervisor_pid'),
                   'supervisor_alive': False, 'process_locks_were_free': True}
        receipt['receipt_sha256'] = audit.digest(receipt)
        audit.atomic(continuation / 'retirement-receipt.json', receipt)
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--continuation', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--superseded-by', required=True)
    for name in ('authorization', 'admission', 'status', 'control', 'stop'):
        parser.add_argument('--expected-' + name, required=True)
    args = parser.parse_args(argv)
    receipt = retire(args.continuation, args.root, args.superseded_by, args.expected_authorization,
                     args.expected_admission, args.expected_status, args.expected_control, args.expected_stop)
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
