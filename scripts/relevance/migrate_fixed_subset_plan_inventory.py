#!/usr/bin/env python3
"""One-shot, hash-authorized migration of a frozen fixed-subset plan inventory."""
import argparse
import hashlib
import json
from pathlib import Path
import re

import audit
import luna_batch_qa as luna
from production import (ContinuationIntegrityError, FIXED_SUBSET_LEGACY_PLAN_KEYS,
                        FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES, immutable_batch_inventory,
                        runner_lock, validate_mixed_batch_inventories)


def migrate(root, continuation, expected_plan_file_sha256, expected_plan_sha256,
            frozen_at=None):
    root, continuation = Path(root).resolve(), Path(continuation).resolve()
    with runner_lock(root / 'production-owner.lock'):
        with runner_lock(root / 'runner.lock'):
            return _migrate_locked(root, continuation, expected_plan_file_sha256,
                                   expected_plan_sha256, frozen_at)


def _migrate_locked(root, continuation, expected_plan_file_sha256, expected_plan_sha256,
                    frozen_at=None):
    if (not re.fullmatch(r'[0-9a-f]{64}', str(expected_plan_file_sha256))
            or not re.fullmatch(r'[0-9a-f]{64}', str(expected_plan_sha256))):
        raise ContinuationIntegrityError('Both known pre-migration plan hashes are required')
    path = continuation / 'continuation-plan.json'
    if not path.is_file() or luna.sha(path) != expected_plan_file_sha256:
        raise ContinuationIntegrityError('Frozen plan raw hash is not the known pre-migration authority')
    plan = luna.read(path)
    unsigned = {key: value for key, value in plan.items() if key != 'plan_sha256'}
    known = FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES.get(plan.get('continuation_id'))
    if (plan.get('schema_version') != 'snippy-fixed-subset-plan-v1'
            or tuple(plan) != FIXED_SUBSET_LEGACY_PLAN_KEYS
            or not known
            or {key: known.get(key) for key in (
                'prior_plan_file_sha256', 'prior_plan_sha256')} != {
                    'prior_plan_file_sha256': expected_plan_file_sha256,
                    'prior_plan_sha256': expected_plan_sha256}
            or plan.get('plan_sha256') != expected_plan_sha256
            or audit.digest(unsigned) != expected_plan_sha256
            or list(plan)[-1:] != ['plan_sha256']):
        raise ContinuationIntegrityError('Frozen plan self-hash/order is not the known pre-migration authority')
    if ('mixed_batch_inventories' in plan or 'mixed_batch_inventory_migration' in plan
            or (continuation / 'preflight-hold-dispositions.json').exists()):
        raise ContinuationIntegrityError('Plan inventory migration is not a fresh pre-admission migration')
    owner_path = root / 'production-owner.json'
    if owner_path.is_file() and luna.read(owner_path).get('active') is True:
        raise ContinuationIntegrityError('Cannot migrate while a production owner is active')

    names = []
    for hold in plan.get('preflight_holds', []):
        name = hold.get('batch_name')
        if name not in names:
            names.append(name)
    inventories = [immutable_batch_inventory(root, name) for name in names]
    original = dict(plan)
    plan.pop('plan_sha256')
    plan['mixed_batch_inventories'] = inventories
    plan['mixed_batch_inventory_migration'] = {
        'prior_plan_file_sha256': expected_plan_file_sha256,
        'prior_plan_sha256': expected_plan_sha256,
        'frozen_at': frozen_at or audit.now(),
    }
    plan['plan_sha256'] = audit.digest(plan)
    predicted_raw = hashlib.sha256(json.dumps(
        plan, ensure_ascii=False, indent=2, default=str).encode('utf-8')).hexdigest()
    if ((known.get('migrated_plan_file_sha256')
         and predicted_raw != known['migrated_plan_file_sha256'])
            or (known.get('migrated_plan_sha256')
                and plan['plan_sha256'] != known['migrated_plan_sha256'])):
        raise ContinuationIntegrityError('Migrated plan does not match its known new authority')
    if luna.sha(path) != expected_plan_file_sha256:
        raise ContinuationIntegrityError('Frozen plan changed while inventory was being computed')
    audit.atomic(path, plan)

    saved = luna.read(path)
    old_keys = [key for key in original if key != 'plan_sha256']
    if ([key for key in saved if key not in (
            'mixed_batch_inventories', 'mixed_batch_inventory_migration', 'plan_sha256')] != old_keys
            or any(saved.get(key) != original[key] for key in old_keys)
            or saved.get('plan_sha256') != audit.digest({
                key: value for key, value in saved.items() if key != 'plan_sha256'})):
        raise ContinuationIntegrityError('Migrated plan changed pre-existing semantics or field order')
    validate_mixed_batch_inventories(root, saved, verify_files=True)
    if ((known.get('migrated_plan_file_sha256')
         and luna.sha(path) != known['migrated_plan_file_sha256'])
            or (known.get('migrated_plan_sha256')
                and saved['plan_sha256'] != known['migrated_plan_sha256'])):
        raise ContinuationIntegrityError('Migrated plan does not match its known new authority')
    return {'prior_plan_file_sha256': expected_plan_file_sha256,
            'prior_plan_sha256': expected_plan_sha256,
            'plan_file_sha256': luna.sha(path), 'plan_sha256': saved['plan_sha256'],
            'mixed_batch_count': len(inventories),
            'mixed_batch_file_count': sum(row['file_count'] for row in inventories),
            'mixed_batch_total_bytes': sum(row['total_bytes'] for row in inventories)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--continuation', type=Path, required=True)
    parser.add_argument('--expected-plan-file-sha256', required=True)
    parser.add_argument('--expected-plan-sha256', required=True)
    parser.add_argument('--frozen-at')
    args = parser.parse_args()
    print(json.dumps(migrate(
        args.root, args.continuation, args.expected_plan_file_sha256,
        args.expected_plan_sha256, args.frozen_at), indent=2))


if __name__ == '__main__':
    main()
