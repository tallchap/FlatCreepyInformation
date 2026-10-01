#!/usr/bin/env python3
"""Resumable production queue: staged excerpts → existing Luna gate → publication.

No new editorial model or weakened gate. Unresolved evidence is retained for Astra.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path, PurePosixPath
import queue
import re
import shutil
import threading
from types import SimpleNamespace
import requests
import audit
from captions import parse_captions
import luna_batch_qa as luna
import process_astra as media
import publish_astra

TERMINAL = {'published', 'already_published', 'awaiting_astra', 'failed'}
# Scoped throughput tuning may overlap more whole batches; local caps never change.
TUNING_MAX_BATCH_WORKERS = 6
FULL_CONTINUATION_SCOPE = 'all_remaining_frozen_manifest'
FIXED_SUBSET_SCOPE = 'fixed_subset_frozen_manifest'
FIXED_SUBSET_EXPECTED_COUNT = 340
PREFLIGHT_HOLD_SCHEMA = 'snippy-fixed-subset-preflight-holds-v1'
FIXED_SUBSET_LEGACY_PLAN_KEYS = (
    'schema_version', 'continuation_id', 'created_at', 'manifest_sha256',
    'culled_ids_sha256', 'authorization_sha256', 'selected_ids_sha256',
    'authorized_candidate_ids', 'authorized_candidate_count', 'target_candidate_count',
    'candidate_ids', 'slots', 'preflight_holds', 'protected_record_sha256',
    'protected_absent_ids', 'baseline_record_sha256', 'preserved_file_sha256',
    'maximum_batch_members', 'maximum_batch_workers', 'render_slots', 'asr_slots',
    'publication_writers', 'min_release_confidence', 'max_passes', 'plan_sha256')
FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES = {
    'SNIPPY-SELECTED340-LUNA-20261001': {
        'prior_plan_file_sha256': '1b97f603a59a00d91eed93dc4a7668a2a7387faaa5463d74ad8f5a17fdcf4270',
        'prior_plan_sha256': '69faa2c849a9fb822e8771d1caa800976db567def920ab75284b7e7d69ca6b4f',
        'migrated_plan_file_sha256': '530c11ad9cb1b8ffc924f4604858861838e34470eb0951dce7a4a7ae5ae0754f',
        'migrated_plan_sha256': 'ccb048c9b05ed690edf1fabdb854dfde078e481954a75da4dce0bb770682a153',
    },
}


def validate_preflight_hold_receipt(root, continuation_dir, plan, required=False,
                                    verify_mixed_inventory=False):
    """Return immutable virtual hold dispositions without rewriting old records.

    A selected member of a historical paid batch may be unsafe to replay because
    the batch also contains out-of-scope IDs.  Those records predate this scoped
    continuation and must remain byte-for-byte unchanged.  The scoped terminal
    disposition therefore lives beside the continuation authority, not in the
    shared production ledger.
    """
    root, continuation_dir = Path(root).resolve(), Path(continuation_dir).resolve()
    planned = plan.get('preflight_holds', [])
    plan_inventories = validate_mixed_batch_inventories(
        root, plan, verify_files=verify_mixed_inventory)
    path = continuation_dir / 'preflight-hold-dispositions.json'
    known = FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES.get(plan.get('continuation_id'), {})
    if (known.get('migrated_plan_file_sha256')
            and luna.sha(continuation_dir / 'continuation-plan.json') !=
            known['migrated_plan_file_sha256']):
        raise ContinuationIntegrityError('Migrated fixed-subset plan raw authority changed')
    if not path.exists():
        if required and planned:
            raise ContinuationIntegrityError('Fixed-subset preflight hold receipt is missing')
        return {}
    receipt = luna.read(path)
    unsigned = {key: value for key, value in receipt.items() if key != 'receipt_sha256'}
    if (receipt.get('schema_version') != PREFLIGHT_HOLD_SCHEMA
            or receipt.get('job_id') != plan.get('continuation_id')
            or receipt.get('plan_sha256') != plan.get('plan_sha256')
            or receipt.get('receipt_sha256') != audit.digest(unsigned)
            or not receipt.get('created_at')):
        raise ContinuationIntegrityError('Fixed-subset preflight hold receipt identity changed')
    expected_ids = [row.get('candidate_id') for row in planned]
    rows = receipt.get('holds')
    if (not isinstance(rows, list) or [row.get('candidate_id') for row in rows] != expected_ids
            or len(expected_ids) != len(set(expected_ids))):
        raise ContinuationIntegrityError('Fixed-subset preflight hold membership changed')
    inventories = receipt.get('mixed_batch_inventories')
    if inventories != plan_inventories:
        raise ContinuationIntegrityError('Fixed-subset mixed batch inventory membership changed')
    by_id = {}
    planned_by_id = {row['candidate_id']: row for row in planned}
    baseline = plan.get('baseline_record_sha256', {})
    for row in rows:
        vid = row['candidate_id']
        source = root / 'records' / f'{vid}.json'
        packet = root / 'input' / 'candidates' / f'{vid}.json'
        planned_row = planned_by_id[vid]
        expected_hash = baseline.get(vid)
        if (row.get('effective_status') != 'awaiting_astra'
                or row.get('reason') != planned_row.get('detail')
                or row.get('mixed_batch') != planned_row.get('batch_name')
                or row.get('mixed_batch_plan_sha256') != planned_row.get('batch_plan_sha256')
                or row.get('record_path') != str(source.resolve())
                or row.get('record_sha256') != expected_hash
                or not expected_hash or not source.is_file() or luna.sha(source) != expected_hash
                or row.get('packet_path') != str(packet.resolve()) or not packet.is_file()):
            raise ContinuationIntegrityError('Fixed-subset preflight hold evidence changed: ' + vid)
        by_id[vid] = row
    return by_id


def load_lf_ids(path, expected_sha256=None):
    """Read one immutable ASCII ID per LF-terminated line."""
    path = Path(path)
    raw = path.read_bytes()
    actual = luna.sha(path)
    if expected_sha256 is not None and actual != expected_sha256:
        raise ValueError('Fixed subset ID file hash changed')
    if not raw or raw.startswith(b'\xef\xbb\xbf') or b'\r' in raw or not raw.endswith(b'\n'):
        raise ValueError('Fixed subset ID file must be BOM-free, LF-only, and newline terminated')
    try:
        ids = raw[:-1].decode('ascii').split('\n')
    except UnicodeDecodeError as exc:
        raise ValueError('Fixed subset IDs must be ASCII') from exc
    if (any(not re.fullmatch(r'[A-Za-z0-9_-]{11}', vid) for vid in ids)
            or len(ids) != len(set(ids))):
        raise ValueError('Fixed subset IDs are invalid or duplicated')
    return ids


def validate_fixed_subset_protection_cover(plan, manifest_ids, selected_ids, current_record_ids):
    """Prove outsiders are exactly and disjointly protected as present/absent.

    ``protected_record_sha256`` may also contain immutable selected terminal
    records.  Only its out-of-scope keys participate in the outsider cover.
    Every current ledger filename must belong either to the selected scope or
    to that protected-existing outsider partition.
    """
    manifest, selected, current = set(manifest_ids), set(selected_ids), set(current_record_ids)
    protected = plan.get('protected_record_sha256')
    absent_rows = plan.get('protected_absent_ids')
    if not isinstance(protected, dict) or not isinstance(absent_rows, list):
        raise ValueError('Fixed-subset outsider protection inventories are malformed')
    if any(not isinstance(vid, str) for vid in [*protected, *absent_rows]):
        raise ValueError('Fixed-subset outsider protection inventories are duplicated or invalid')
    if (len(absent_rows) != len(set(absent_rows))
            or any(not isinstance(digest, str)
                   or not re.fullmatch(r'[0-9a-f]{64}', digest)
                   for digest in protected.values())):
        raise ValueError('Fixed-subset outsider protection inventories are duplicated or invalid')
    protected_ids, absent = set(protected), set(absent_rows)
    protected_outside = protected_ids - selected
    outside = manifest - selected
    if selected - manifest:
        raise ValueError('Fixed-subset selected IDs escape the frozen manifest')
    if (protected_ids - manifest or absent - manifest or absent & selected
            or protected_outside & absent or protected_outside | absent != outside):
        raise ValueError('Fixed-subset outsider protection cover is not exact and disjoint')
    outside_manifest = current - manifest
    if outside_manifest:
        raise ValueError('Ledger record filenames escape the frozen manifest: '
                         + ','.join(sorted(outside_manifest)[:10]))
    unauthorized = current - selected - protected_outside
    if unauthorized:
        raise ValueError('Ledger records are neither selected nor protected existing outsiders: '
                         + ','.join(sorted(unauthorized)[:10]))
    missing = protected_outside - current
    if missing:
        raise ValueError('Protected existing outsider records disappeared: '
                         + ','.join(sorted(missing)[:10]))
    appeared = current & absent
    if appeared:
        raise ValueError('Protected absent outsider records appeared: '
                         + ','.join(sorted(appeared)[:10]))
    return {'manifest_ids': manifest, 'selected_ids': selected,
            'protected_existing_outside_ids': protected_outside,
            'protected_absent_ids': absent, 'current_record_ids': current}


def immutable_batch_inventory(root, batch_name):
    """Hash the exact recursive file inventory of one historical paid batch.

    Request bodies may contain credentials, so this receipt records only safe
    relative paths, byte counts, and raw SHA-256 values. Directories are never
    followed through symlinks or junctions.
    """
    root = Path(root).resolve()
    batches = root / 'batches'
    if (not isinstance(batch_name, str) or not batch_name
            or Path(batch_name).name != batch_name or batch_name in ('.', '..')
            or any(char in batch_name for char in ('/', '\\', ':', '\0'))):
        raise ContinuationIntegrityError('Mixed historical batch name is unsafe')
    if (not batches.is_dir() or batches.is_symlink()
            or getattr(batches, 'is_junction', lambda: False)()):
        raise ContinuationIntegrityError('Historical batches directory is missing or unsafe')
    batches_resolved = batches.resolve()
    if batches_resolved != root / 'batches':
        raise ContinuationIntegrityError('Historical batches directory escapes the production root')
    source = batches / batch_name
    if (not source.is_dir() or source.is_symlink()
            or getattr(source, 'is_junction', lambda: False)()):
        raise ContinuationIntegrityError(
            'Mixed historical batch directory is missing or unsafe: ' + batch_name)
    resolved = source.resolve()
    if not resolved.is_relative_to(batches_resolved):
        raise ContinuationIntegrityError(
            'Mixed historical batch directory escapes the production root')

    def enumerate_files(directory):
        found = []
        # Check each link/reparse point before descent. Path.rglob may traverse
        # Windows junctions before the caller gets a chance to reject them.
        for path in sorted(directory.iterdir(), key=lambda item: (item.name.casefold(), item.name)):
            if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
                raise ContinuationIntegrityError(
                    'Symlink/junction in mixed historical batch: ' + batch_name)
            actual = path.resolve()
            if not actual.is_relative_to(resolved):
                raise ContinuationIntegrityError(
                    'Mixed historical batch artifact escapes its directory: ' + batch_name)
            if path.is_dir():
                found.extend(enumerate_files(path))
                continue
            if not path.is_file():
                raise ContinuationIntegrityError(
                    'Unsupported artifact in mixed historical batch: ' + batch_name)
            found.append(path)
        return found

    paths = enumerate_files(source)
    files = []
    for path in paths:
        before = path.stat()
        digest = luna.sha(path)
        after = path.stat()
        if ((before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                raise ContinuationIntegrityError(
                    'Mixed historical batch changed during inventory: ' + batch_name)
        files.append({'path': path.relative_to(source).as_posix(),
                      'size': after.st_size, 'sha256': digest})
    if [path.relative_to(source).as_posix() for path in enumerate_files(source)] != [
            row['path'] for row in files]:
        raise ContinuationIntegrityError(
            'Mixed historical batch changed during inventory: ' + batch_name)
    files.sort(key=lambda row: row['path'])
    if len(files) != len({row['path'].casefold() for row in files}):
        raise ContinuationIntegrityError(
            'Duplicate artifact path in mixed historical batch: ' + batch_name)
    inventory = {'batch_name': batch_name, 'root_relative_path': 'batches/' + batch_name,
                 'files': files, 'file_count': len(files),
                 'total_bytes': sum(row['size'] for row in files)}
    inventory['inventory_sha256'] = audit.digest(inventory)
    return inventory


def validate_mixed_batch_inventories(root, plan, verify_files=False):
    """Validate the plan-bound exact inventories for all preflight-held batches."""
    expected = []
    holds = plan.get('preflight_holds', [])
    if not isinstance(holds, list) or any(not isinstance(row, dict) for row in holds):
        raise ContinuationIntegrityError('Fixed-subset preflight holds are malformed')
    for hold in holds:
        name = hold.get('batch_name')
        if name not in expected:
            expected.append(name)
    inventories = plan.get('mixed_batch_inventories')
    if (not isinstance(inventories, list)
            or any(not isinstance(row, dict) for row in inventories)
            or [row.get('batch_name') for row in inventories] != expected
            or len(expected) != len(set(expected))):
        raise ContinuationIntegrityError('Fixed-subset plan mixed batch inventories are missing or changed')
    for inventory in inventories:
        name, files = inventory.get('batch_name'), inventory.get('files')
        if (set(inventory) != {'batch_name', 'root_relative_path', 'files', 'file_count',
                              'total_bytes', 'inventory_sha256'}
                or inventory.get('root_relative_path') != 'batches/' + str(name)
                or not isinstance(files, list)
                or any(not isinstance(row, dict) or set(row) != {'path', 'size', 'sha256'}
                       for row in files)):
            raise ContinuationIntegrityError('Fixed-subset mixed batch inventory is malformed: ' + str(name))
        paths = [row.get('path') for row in files]
        if (paths != sorted(paths)
                or len(paths) != len({path.casefold() for path in paths if isinstance(path, str)})
                or any(not isinstance(path, str) or not path
                       or PurePosixPath(path).is_absolute()
                       or PurePosixPath(path).as_posix() != path
                       or any(part in ('', '.', '..') for part in PurePosixPath(path).parts)
                       or any(char in path for char in ('\\', ':', '\0')) for path in paths)
                or any(type(row.get('size')) is not int or row['size'] < 0
                       or not re.fullmatch(r'[0-9a-f]{64}', str(row.get('sha256', '')))
                       for row in files)
                or inventory.get('file_count') != len(files)
                or inventory.get('total_bytes') != sum(row['size'] for row in files)
                or inventory.get('inventory_sha256') != audit.digest({
                    key: value for key, value in inventory.items() if key != 'inventory_sha256'})):
            raise ContinuationIntegrityError('Fixed-subset mixed batch inventory is invalid: ' + str(name))
        if verify_files and inventory != immutable_batch_inventory(root, name):
            raise ContinuationIntegrityError('Fixed-subset mixed batch inventory changed: ' + str(name))
    migration = plan.get('mixed_batch_inventory_migration')
    known = FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES.get(plan.get('continuation_id'))
    if migration is None and plan.get('continuation_id') in FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES:
        raise ContinuationIntegrityError(
            'Fixed-subset mixed batch inventory migration provenance is missing')
    if migration is not None and (not isinstance(migration, dict)
            or set(migration) != {'prior_plan_file_sha256', 'prior_plan_sha256', 'frozen_at'}
            or not re.fullmatch(r'[0-9a-f]{64}', str(migration.get('prior_plan_file_sha256', '')))
            or not re.fullmatch(r'[0-9a-f]{64}', str(migration.get('prior_plan_sha256', '')))
            or not migration.get('frozen_at')
            or {key: migration.get(key) for key in (
                'prior_plan_file_sha256', 'prior_plan_sha256')} !=
            ({key: known.get(key) for key in (
                'prior_plan_file_sha256', 'prior_plan_sha256')} if known else None)
            or (known and known.get('migrated_plan_sha256')
                and plan.get('plan_sha256') != known['migrated_plan_sha256'])):
        raise ContinuationIntegrityError('Fixed-subset mixed batch inventory migration provenance is invalid')
    return inventories


def process_alive(pid):
    """Conservative cross-platform PID liveness probe without optional deps."""
    if type(pid) is not int or pid <= 0:
        return False
    if os.name == 'nt':
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class ContinuationIntegrityError(ValueError):
    """An immutable admission/evidence gate changed; drain the whole runner."""


@contextmanager
def runner_lock(path):
    """Hold one nonblocking process lock on both Windows and POSIX."""
    with Path(path).open('a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


def private_environment(path):
    """Load only production credentials from an explicitly supplied private file."""
    allowed = {'OPENAI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'}
    for line in Path(path).read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key.strip() not in allowed:
            raise ValueError('Private environment file contains an unsupported setting')
        os.environ[key.strip()] = value.strip().strip('\"\'')


def artifact_path(root, value):
    """Resolve copied checkpoint paths without editing hash-bound evidence."""
    normalized = str(value).replace('\\', '/')
    mapping_path = Path(root) / 'checkpoint-paths.json'
    mapping = luna.read(mapping_path) if mapping_path.exists() else {}
    for old, new in sorted(mapping.items(), key=lambda pair: len(pair[0]), reverse=True):
        prefix = old.replace('\\', '/').rstrip('/')
        if normalized == prefix or normalized.startswith(prefix + '/'):
            base = Path(new).resolve()
            mapped = (base / normalized[len(prefix):].lstrip('/')).resolve()
            if not mapped.is_relative_to(base):
                raise ValueError('Checkpoint path escapes its mapped root')
            return mapped
    path = Path(value)
    return path if path.is_absolute() else Path(root) / path


def batch_namespace(root, requested):
    """Persist the operational namespace so resumes reuse the same paid cache."""
    path = Path(root) / 'runner-config.json'
    saved = luna.read(path) if path.exists() else {}
    namespace = requested if requested is not None else saved.get('batch_namespace', '')
    if namespace and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', namespace):
        raise ValueError('Batch namespace must be a simple name of at most 80 characters')
    if saved and namespace != saved['batch_namespace']:
        raise ValueError('Batch namespace differs from the saved runner configuration')
    if not saved:
        audit.atomic(path, {'batch_namespace': namespace})
    return namespace


def load_batch_tuning(path, continuation_id):
    """Validate an explicit, hash-bound batch-overlap authorization.

    It may raise only the number of whole batches in flight. Batch membership,
    render slots (2), ASR slots (1) and the serialized publication writer stay
    frozen; the continuation plan hash is checked once that plan is loaded.
    """
    path = Path(path).resolve()
    tuning = luna.read(path)
    hash_payload = {key: value for key, value in tuning.items() if key != 'authorization_sha256'}
    maximum = tuning.get('maximum_batch_workers')
    if (tuning.get('schema_version') != 'snippy-batch-tuning-v1' or tuning.get('continuation_id') != continuation_id
            or type(maximum) is not int or not 2 <= maximum <= TUNING_MAX_BATCH_WORKERS
            or tuning.get('maximum_batch_members') != 5 or tuning.get('render_slots') != 2 or tuning.get('asr_slots') != 1
            or not re.fullmatch(r'[A-Z0-9][A-Z0-9_-]{0,79}', str(tuning.get('tuning_job_id', '')))
            or not re.fullmatch(r'[0-9a-f]{64}', str(tuning.get('continuation_plan_sha256', '')))
            or tuning.get('authorization_sha256') != audit.digest(hash_payload)):
        raise ValueError('Batch tuning authorization is invalid, has a self-hash mismatch, or exceeds frozen local caps')
    if getattr(luna.RENDER_LOCK, '_initial_value', None) != 2 or not isinstance(luna.ASR_LOCK, type(threading.Lock())):
        raise ValueError('Local render/ASR caps differ from the tuning authorization')
    control = Path(tuning.get('control_path', ''))
    if not control.is_absolute() or control.resolve().parent != path.parent:
        raise ValueError('Batch worker control must live beside its authorization')
    return {**tuning, '_path': str(path), '_sha256': luna.sha(path)}


def bound_batch_plan(batch, slot_ids, directories, packets):
    """Freeze paid-call membership and evidence before the first request.

    A partial publication must never shrink the batch and escape its existing
    paid-response or ambiguous-call cache on restart.
    """
    path = batch / 'batch-plan.json'
    saved = luna.read(path) if path.exists() else None
    if saved:
        if saved.get('slot_candidate_ids') != slot_ids:
            raise ValueError('Saved batch slot membership differs from manifest')
        directories = [Path(value) for value in saved['directories']]
    else:
        if any(batch.rglob('call-state.json')) or any(batch.rglob('request.json')) or any(batch.rglob('pipeline-results.json')):
            raise ValueError('Paid batch artifacts exist without frozen membership; explicit reconciliation required')
        if not directories:
            raise ValueError('Cannot create an empty paid batch')
    evidence = {}
    for directory in directories:
        package = luna.current_package(directory, packets)
        vid = package['evidence']['candidate_id']
        if vid not in slot_ids or vid in evidence:
            raise ValueError('Paid batch contains duplicate or out-of-slot candidates')
        evidence[vid] = package['evidence']['evidence_hash']
    run_id = 'production-1644-v1-' + batch.name
    identity = {'inputs': evidence, 'finalizer_prompt': luna.sha(luna.PROMPT),
                'verifier_prompt': luna.sha(luna.VERIFIER_PROMPT), 'max_passes': luna.MAX_PASSES,
                'experiment_id': run_id, 'release_policy_version': luna.RELEASE_POLICY_VERSION,
                'min_release_confidence': .95, 'decision_schema_hash': audit.digest(luna.SCHEMA),
                'finalizer_hard_flag_routing': True}
    plan = {'schema_version': 'snippy-production-batch-plan-v1', 'slot_candidate_ids': slot_ids,
            'candidate_ids': list(evidence), 'directories': [str(Path(d).resolve()) for d in directories],
            'run_id': run_id, 'pipeline_identity': identity, 'run_hash': audit.digest(identity)}
    if saved:
        if saved != plan:
            raise ValueError('Frozen batch evidence or policy changed; refusing new paid request')
    else:
        audit.atomic(path, plan)
    return plan


def planned_pipeline(plan, batch, packets, whisper):
    """Reuse a completed exact batch, including already-disposed members."""
    result_path = batch / 'pipelines' / plan['run_hash'] / 'pipeline-results.json'
    cached = result_path.exists()
    if cached:
        result = luna.read(result_path)
    else:
        result = luna.pipeline(SimpleNamespace(clips=[Path(d) for d in plan['directories']],
                               packets=packets, output=batch, run_id=plan['run_id'], images=[],
                               min_release_confidence=.95, whisper_cli=whisper))
    ids = [decision['candidate_id'] for decision in result['decisions']]
    if len(ids) != len(set(ids)) or set(ids) != set(plan['candidate_ids']) or result.get('run_hash') != plan['run_hash']:
        raise ValueError('Pipeline receipt does not match frozen batch membership/identity')
    if result.get('release_policy_version') != luna.RELEASE_POLICY_VERSION or result.get('min_release_confidence') != .95:
        raise ValueError('Pipeline receipt release policy changed')
    for decision in result['decisions']:
        if decision.get('complete') and not luna.release_gate_passed(decision.get('release_gate'), .95):
            raise ValueError('Cached PASS missing required release gate')
        if luna.sha(decision['media_path']) != decision['media_sha256'] or audit.digest(luna.read(decision['recipe_path'])) != decision['recipe_hash']:
            raise ValueError('Pipeline receipt artifact hash drift')
    if cached:
        result = {**result, 'cache_hit': True, 'new_cost_usd': 0, 'api_calls_this_invocation': 0}
        audit.atomic(batch / 'pipeline-results.json', result)
    return result


def seed(packet, source):
    """Stage caption-aligned context; finalizer/verifier still decide publication."""
    proposal = packet['luna_proposal']
    start, end = proposal['start_seconds'], proposal['end_seconds']
    if not all(type(x) in (int, float) and math.isfinite(x) for x in (start, end)) or not 0 <= start < end:
        raise ValueError('Invalid proposal timestamps')
    captions = parse_captions(source['transcript'])
    lo, hi = packet['context_start_seconds'], min(packet['context_end_seconds'], packet['source_duration_seconds'])
    boundaries = sorted({t for t, _ in captions if lo <= t <= hi} | {float(packet['source_duration_seconds'])})
    # Preserve the entire proposed passage; never silently truncate an oversize one.
    left = [t for t in boundaries if lo <= t <= start]
    right = [t for t in boundaries if end <= t <= hi]
    if not left or not right:
        raise ValueError('Proposal outside available caption boundaries')
    a, b = max(left), min(right)
    if b - a > 240:
        raise ValueError('Proposal exceeds 240 seconds after caption alignment; Astra required')
    for t in reversed([t for t in boundaries if max(lo, start - 10) <= t < a]):
        if b - t <= 240:
            a = t
    for t in [t for t in boundaries if b < t <= min(hi, end + 10)]:
        if t - a <= 240:
            b = t
    if not 15 <= b - a <= 240:
        raise ValueError('Cannot stage a 15–240 second passage')
    return {'schema_version': 'snippy-astra-edit-v1', 'candidate_id': packet['candidate_id'],
            'source_input_hash': packet['source_input_hash'], 'decision': 'revise', 'clip_worthy': True,
            'title': proposal.get('claim') or packet['title'],
            'speaker': packet.get('speaker_source') or 'Unidentified speaker',
            'reason': 'PROVISIONAL SOURCE ENVELOPE ONLY; not editorial approval. ' + packet['luna_reason'],
            'edit_notes': 'Staged original caption context for Luna review. Must pass independent final QA before publication.',
            'edits': [{'start_seconds': a, 'end_seconds': b,
                       'transcript': ' '.join(text for t, text in captions if a <= t < b)}]}


def live_receipt(receipt):
    response = requests.get('https://www.snippysaurus.com/api/snippets/auto',
                            params={'videoId': receipt['video_id']}, timeout=45)
    response.raise_for_status()
    rows = [r for r in response.json() if r['snippetId'] == receipt['snippet_id']]
    if len(rows) != 1 or rows[0]['gcsUrl'] != receipt['gcs_url']:
        raise ValueError('Published clip missing or mismatched in live site API')
    response = requests.get(receipt['gcs_url'], headers={'Range': 'bytes=0-31'}, timeout=45)
    response.raise_for_status()
    if response.status_code != 206 or len(response.content) != 32:
        raise ValueError('Cloud range playback failed')


def verify(root):
    manifest = luna.read(root / 'input/manifest.json')
    wanted = {x['candidate_id'] for x in manifest['candidates']}
    rows = [luna.read(p) for p in (root / 'records').glob('*.json')]
    ids = [r['candidate_id'] for r in rows]
    receipts_valid = True
    media_valid = True
    for row in rows:
        if row['status'] not in ('published', 'already_published'):
            continue
        try:
            receipt = luna.read(artifact_path(root, row['publication_receipt']))
            receipts_valid &= receipt.get('passed') is True and receipt['video_id'] == row['candidate_id']
            if row['status'] == 'published':
                directory = artifact_path(root, row['final_directory'])
                qa = luna.read(directory / 'final-qa.json')
                media_valid &= (luna.sha(directory / 'clip.mp4') == receipt['media_sha256'] == qa['media_sha256']
                                and audit.digest(luna.read(directory / 'recipe.json')) == receipt['recipe_hash'] == qa['recipe_hash']
                                and qa.get('passed') is True)
        except (OSError, ValueError, KeyError):
            receipts_valid = False
    checks = {'exact_coverage': len(ids) == len(set(ids)) == len(wanted) and set(ids) == wanted,
              'all_disposed': all(r['status'] in TERMINAL for r in rows),
              'operational_failures_resolved': not any(r['status'] == 'failed' for r in rows),
              'publication_receipts': receipts_valid, 'published_media_and_qa_hashes': media_valid}
    imported = [r for r in rows if r.get('checkpoint_origin') == 'Mac' and r['status'] == 'already_published']
    if imported:
        prior_path = root / 'prior-verification.json'
        checks['checkpoint_publications_verified'] = prior_path.exists() and luna.read(prior_path).get('passed') is True
    all_completed = len(rows) == len(wanted) and all(r['status'] in ('published', 'already_published') for r in rows)
    report = {'requested': len(wanted), 'time': audit.now(), 'counts': dict(Counter(r['status'] for r in rows)),
              'checks': checks, 'passed': all(checks.values()), 'all_completed': all_completed,
              'improver': 'Frozen calibrated prompts; Astra escalation evidence retained, no automatic prompt mutation'}
    audit.atomic(root / 'verification.json', report)
    return report


class Runner:
    def __init__(self, root, whisper, limit=None, machine=None, namespace=None, batch_workers=1, experiment_id=None,
                 stream_id=None, max_candidates=None, continuation_id=None, continuation_authorization=None,
                 tuning_authorization=None, continuation_plan_only=False):
        if batch_workers not in range(1, 11):
            raise ValueError('Batch workers must be between 1 and 10')
        if tuning_authorization and not continuation_id:
            raise ValueError('Batch tuning authorization applies only to an authorized continuation')
        self.tuning = load_batch_tuning(tuning_authorization, continuation_id) if tuning_authorization else None
        continuation_cap = self.tuning['maximum_batch_workers'] if self.tuning else 2
        if batch_workers > 2 and not experiment_id and not self.tuning:
            raise ValueError('More than two workers requires a frozen bounded experiment')
        if experiment_id and (batch_workers != 10 or limit != 10):
            raise ValueError('The bounded experiment requires exactly 10 workers and max-batches 10')
        if stream_id and (experiment_id or batch_workers > 2 or max_candidates not in range(1, 6)):
            raise ValueError('Streaming requires a unique stream-id, 1-5 max-candidates, and at most two batch workers')
        if max_candidates is not None and not stream_id:
            raise ValueError('max-candidates requires a frozen stream-id')
        if bool(continuation_id) != bool(continuation_authorization):
            raise ValueError('Continuation requires both its job ID and explicit authorization file')
        if continuation_id and (experiment_id or stream_id or limit is not None or batch_workers > continuation_cap):
            raise ValueError('Continuation requires unlimited frozen scope and at most two batch workers '
                             'unless an explicit tuning authorization raises that cap')
        self.root, self.whisper, self.limit = root.resolve(), whisper, limit
        self.continuation_id = continuation_id
        self.continuation_authorization = Path(continuation_authorization).resolve() if continuation_authorization else None
        self.continuation = None
        self.continuation_plan_only = bool(continuation_plan_only)
        self.continuation_scope = None
        self.authorization = None
        self.fixed_subset_ids = None
        self.fixed_subset_set = None
        self.continuation_file_sha256 = None
        self.recovery_proofs = {}
        frozen_path = self.root / 'experiment-plan.json'
        if experiment_id and (self.root / 'experiment-status.json').exists():
            previous = luna.read(self.root / 'experiment-status.json')
            if (previous.get('experiment_id') == experiment_id and previous.get('phase') in ('paused', 'cancelled')
                    and previous.get('drained_at')):
                raise ValueError('Drained paused/cancelled experiment cannot restart; its frozen scope remains closed')
        if not continuation_id and frozen_path.exists() and (not experiment_id or luna.read(frozen_path).get('experiment_id') != experiment_id):
            status_path = self.root / 'experiment-status.json'
            previous = luna.read(status_path) if status_path.exists() else {}
            if (not stream_id or previous.get('phase') not in ('paused', 'cancelled') or not previous.get('drained_at')
                    or previous.get('experiment_id') != luna.read(frozen_path).get('experiment_id')):
                raise ValueError('Existing bounded experiment requires its matching experiment-id; queue continuation is paused')
        # Immutable inventory must be loaded before continuation authorization
        # is evaluated.  Exact-scope validation binds to these bytes and may
        # never infer a replacement set from the mutable ledger.
        self.input = self.root / 'input'
        self.manifest = luna.read(self.input / 'manifest.json')
        self.candidates = self.manifest['candidates']
        self.prior = luna.read(self.input / 'already-published.json')
        self.records = {p.stem: luna.read(p) for p in (self.root / 'records').glob('*.json')}
        self.sources = {r['video_id']: r for r in audit.inputs(self.input / 'audit-run')}
        self.forbidden = {r['video_id'] for r in luna.read(self.input / 'culled-ids.json')}
        if set(self.sources) & self.forbidden:
            raise ValueError('Frozen production sources intersect the cull exclusion')
        if continuation_id:
            self.validate_continuation_authorization()
        if len(self.candidates) != 1644 or len({r['candidate_id'] for r in self.candidates}) != 1644:
            raise ValueError('Frozen production manifest must contain exactly 1644 unique candidates')
        self.batch_workers = batch_workers
        self.current_batch_workers = batch_workers
        self.batch_workers_error = None
        self.experiment_id = experiment_id
        self.stream_id, self.max_candidates = stream_id, max_candidates
        self.review_barrier = None
        self.publication_lock = threading.Lock()
        self.render_slots = luna.RENDER_LOCK
        self.machine = machine or ('Shadow' if os.name == 'nt' else 'Mac')
        self.namespace = batch_namespace(self.root, namespace)
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.phase = 'starting'
        self.error = None
        self.responses = {}
        checkpoint_status = self.root / 'checkpoint-status.json'
        self.checkpoint_status = luna.read(checkpoint_status) if checkpoint_status.exists() else {}
        self.active_ids = set()
        self.active_batches = {}
        self.batch_claims = set()
        self.last_id = None

    def validate_continuation_authorization(self):
        if not re.fullmatch(r'[A-Z0-9][A-Z0-9_-]{0,79}', self.continuation_id):
            raise ValueError('Continuation ID must be the canonical uppercase Relay job ID')
        authorization = luna.read(self.continuation_authorization)
        unsigned = {key: value for key, value in authorization.items() if key != 'authorization_sha256'}
        manifest_path = self.root / 'input/manifest.json'
        cull_path = self.root / 'input/culled-ids.json'
        scope = authorization.get('scope')
        if (authorization.get('job_id') != self.continuation_id
                or scope not in (FULL_CONTINUATION_SCOPE, FIXED_SUBSET_SCOPE)
                or authorization.get('codex_on_shadow') is not True
                or authorization.get('manifest_sha256') != luna.sha(manifest_path)):
            raise ValueError('Continuation authorization does not match job, frozen manifest, scope, or executor')
        self.authorization = authorization
        self.continuation_scope = scope
        if scope == FIXED_SUBSET_SCOPE:
            selected_relative = authorization.get('selected_ids_file')
            checkpoint_import_path = self.root / 'checkpoint-import.json'
            checkpoint_import = luna.read(checkpoint_import_path)
            if (authorization.get('schema_version') != 'snippy-fixed-subset-authorization-v1'
                    or authorization.get('authorization_sha256') != audit.digest(unsigned)
                    or not isinstance(selected_relative, str)
                    or Path(selected_relative).is_absolute()
                    or not re.fullmatch(r'[A-Za-z0-9_.-]+', selected_relative)
                    or authorization.get('culled_ids_sha256') != luna.sha(cull_path)
                    or authorization.get('original_manifest_sha256') != luna.sha(manifest_path)
                    or checkpoint_import.get('original_manifest_sha256') != authorization.get('original_manifest_sha256')
                    or authorization.get('max_batch_members') != 5
                    or authorization.get('batch_workers') != 2
                    or authorization.get('render_slots') != 2
                    or authorization.get('asr_slots') != 1
                    or authorization.get('publication_writers') != 1
                    or authorization.get('min_release_confidence') != .95
                    or authorization.get('max_passes') != luna.MAX_PASSES):
                raise ValueError('Fixed subset authorization policy or immutable input hashes are invalid')
            ids_path = (self.continuation_authorization.parent / selected_relative).resolve()
            if not ids_path.is_relative_to(self.continuation_authorization.parent):
                raise ValueError('Fixed subset ID file escapes its authorization directory')
            ids = load_lf_ids(ids_path, authorization.get('selected_ids_sha256'))
            manifest_ids = {row['candidate_id'] for row in luna.read(manifest_path)['candidates']}
            culled = {row['video_id'] if isinstance(row, dict) else row for row in luna.read(cull_path)}
            if (authorization.get('candidate_count') != len(ids)
                    or len(ids) != FIXED_SUBSET_EXPECTED_COUNT
                    or set(ids) - manifest_ids or set(ids) & culled):
                raise ValueError('Fixed subset count, manifest membership, or cull exclusion failed')
            if authorization.get('recoverable_failed_ids', []) or authorization.get('recovery_proofs', {}):
                raise ValueError('Fixed subset cannot authorize retries of prior terminal failures')
            self.fixed_subset_ids, self.fixed_subset_set = ids, set(ids)
            self.validate_broad_owner_retired()
        recoverable = authorization.get('recoverable_failed_ids', [])
        proofs = authorization.get('recovery_proofs', {})
        if len(recoverable) != len(set(recoverable)) or set(recoverable) != set(proofs):
            raise ValueError('Recovery authorization requires one proof for each unique failed candidate')
        for vid, proof in proofs.items():
            backup = Path(proof['backup_path'])
            if (proof.get('no_prior_paid_membership') is not True or proof.get('maximum_recovery_attempts') != 1
                    or proof.get('classification') != 'windows_local_downstream_disconnect_misclassified_as_transfer_failure'
                    or not backup.is_file() or luna.sha(backup) != proof.get('record_sha256')
                    or luna.read(backup).get('candidate_id') != vid or luna.read(backup).get('status') != 'failed'):
                raise ValueError('Recovery requires an immutable diagnosed local failure backup: ' + vid)
            evidence = proof.get('failure_evidence', {})
            artifact = evidence.get('artifact', {})
            if (evidence.get('full_decode_exit') != 0 or evidence.get('ffprobe_exit') != 0
                    or not Path(artifact.get('path', '')).is_file()
                    or luna.sha(artifact['path']) != artifact.get('sha256')):
                raise ValueError('Recovery failure evidence is missing or changed: ' + vid)
        self.recovery_proofs = proofs
        return authorization

    def validate_broad_owner_retired(self):
        """Bind subset admission to an immutable, drained broad-owner handoff."""
        if getattr(self, 'continuation_scope', None) != FIXED_SUBSET_SCOPE:
            return
        handoff = self.authorization.get('broad_owner_handoff', {})
        status_path = Path(handoff.get('status_path', ''))
        control_path = Path(handoff.get('control_state_path', ''))
        retirement_path = Path(handoff.get('retirement_receipt_path', ''))
        live_authorization_path = Path(handoff.get('live_authorization_path', ''))
        live_admission_path = Path(handoff.get('live_admission_path', ''))
        if (handoff.get('job_id') != 'SNIPPY-LUNA-CONTINUE-20261001'
                or not all(path.is_absolute() for path in (status_path, control_path, retirement_path,
                                                           live_authorization_path, live_admission_path))
                or luna.sha(status_path) != handoff.get('status_sha256')
                or luna.sha(control_path) != handoff.get('control_state_sha256')
                or luna.sha(retirement_path) != handoff.get('retirement_receipt_sha256')
                or luna.sha(live_authorization_path) != handoff.get('live_authorization_sha256')
                or luna.sha(live_admission_path) != handoff.get('live_admission_sha256')):
            raise ContinuationIntegrityError('Broad-owner handoff identity or frozen evidence changed')
        status, control, retirement = luna.read(status_path), luna.read(control_path), luna.read(retirement_path)
        live_authorization, live_admission = luna.read(live_authorization_path), luna.read(live_admission_path)
        runner_status = status.get('runner_status') or {}
        required_pause = handoff.get('required_pause_control_id')
        if (status.get('job_id') != handoff['job_id'] or status.get('phase') != 'paused'
                or status.get('desired') != 'paused' or status.get('own_children_alive') is not False
                or any(status.get(key) is not None for key in ('runner_pid', 'asr_pid', 'asr_launcher_pid'))
                or runner_status.get('active_batches') not in (None, [])
                or runner_status.get('active_ids') not in (None, [])
                or control.get('desired') != 'paused' or required_pause not in control.get('processed_ids', [])
                or control.get('last_applied_order', [None, None, None])[-1] != required_pause
                or status.get('supervisor_pid') != handoff.get('supervisor_pid')
                or process_alive(handoff.get('supervisor_pid'))
                or retirement.get('retired_job_id') != handoff['job_id']
                or retirement.get('superseded_by') != self.continuation_id
                or retirement.get('supervisor_alive') is not False
                or retirement.get('process_locks_were_free') is not True
                or live_authorization.get('scope') != 'revoked'
                or live_authorization.get('superseded_by') != self.continuation_id
                or live_admission.get('approved') is not False
                or live_admission.get('superseded_by') != self.continuation_id):
            raise ContinuationIntegrityError('Broad owner is not immutably paused, drained, and retired')

    def scope_guard(self, vid=None, full=False, verify_mixed_inventory=False):
        """Revalidate fixed scope at every admission/mutation/media/network gate."""
        if getattr(self, 'continuation_scope', None) != FIXED_SUBSET_SCOPE:
            return
        if vid is not None and vid not in self.fixed_subset_set:
            raise ContinuationIntegrityError('Candidate is outside the fixed subset: ' + str(vid))
        # Re-read every immutable authority; in-memory membership is never enough.
        self.validate_continuation_authorization()
        path = self.continuation_authorization.parent / 'continuation-plan.json'
        plan = None
        if self.continuation is not None:
            plan = luna.read(path)
            unsigned = {key: value for key, value in plan.items() if key != 'plan_sha256'}
            if (plan.get('plan_sha256') != audit.digest(unsigned)
                    or plan.get('plan_sha256') != self.continuation.get('plan_sha256')
                    or luna.sha(path) != self.continuation_file_sha256
                    or plan.get('authorization_sha256') != luna.sha(self.continuation_authorization)
                    or plan.get('authorized_candidate_ids') != self.fixed_subset_ids
                    or (FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES.get(
                        plan.get('continuation_id'), {}).get('migrated_plan_file_sha256')
                        not in (None, luna.sha(path)))
                    or (vid is not None and vid not in plan.get('authorized_candidate_ids', []))):
                raise ContinuationIntegrityError('Frozen fixed-subset plan changed or excludes candidate')
            if full:
                for candidate_id, expected in plan.get('protected_record_sha256', {}).items():
                    record = self.root / 'records' / f'{candidate_id}.json'
                    if not record.is_file() or luna.sha(record) != expected:
                        raise ContinuationIntegrityError('Protected prior disposition changed: ' + candidate_id)
                for candidate_id in plan.get('protected_absent_ids', []):
                    if (self.root / 'records' / f'{candidate_id}.json').exists():
                        raise ContinuationIntegrityError('Out-of-scope record appeared: ' + candidate_id)
                for relative, expected in plan.get('preserved_file_sha256', {}).items():
                    source = (self.root / relative).resolve()
                    if not source.is_relative_to(self.root) or not source.is_file() or luna.sha(source) != expected:
                        raise ContinuationIntegrityError('Prior checkpoint or paid batch plan changed: ' + relative)
                # Preflight holds are selected, but their records belong to a
                # historical mixed paid batch.  They remain immutable too; the
                # scoped disposition is recorded beside this continuation.
                for hold in plan.get('preflight_holds', []):
                    candidate_id = hold['candidate_id']
                    record = self.root / 'records' / f'{candidate_id}.json'
                    expected = plan.get('baseline_record_sha256', {}).get(candidate_id)
                    if not expected or not record.is_file() or luna.sha(record) != expected:
                        raise ContinuationIntegrityError('Preflight-held prior record changed: ' + candidate_id)
                validate_preflight_hold_receipt(
                    self.root, self.continuation_authorization.parent, plan, required=False,
                    verify_mixed_inventory=verify_mixed_inventory)
        elif path.exists():
            plan = luna.read(path)
        if plan is not None:
            try:
                validate_fixed_subset_protection_cover(
                    plan, (row['candidate_id'] for row in self.candidates), self.fixed_subset_ids,
                    (record.stem for record in (self.root / 'records').glob('*.json')))
            except ValueError as exc:
                raise ContinuationIntegrityError(str(exc)) from exc
        if not self.continuation_plan_only:
            if plan is None:
                raise ContinuationIntegrityError('Fixed-subset execution requires a frozen plan')
            self.validate_live_fixed_owner(plan)

    def validate_live_fixed_owner(self, plan):
        """Prove the supervisor owns the root OS lock before local or paid work."""
        owner_path = self.root / 'production-owner.json'
        owner_lock = self.root / 'production-owner.lock'
        if not owner_path.is_file():
            raise ContinuationIntegrityError('Live fixed-subset production owner record is missing')
        owner_raw = owner_path.read_bytes()
        owner = luna.read(owner_path)
        auth_path = self.continuation_authorization.resolve()
        plan_path = auth_path.parent / 'continuation-plan.json'
        unsigned = {key: value for key, value in owner.items() if key != 'owner_record_sha256'}
        if (owner.get('schema_version') != 'snippy-production-owner-v1'
                or owner.get('owner_record_sha256') != audit.digest(unsigned)
                or owner.get('active') is not True
                or owner.get('job_id') != self.continuation_id
                or owner.get('pid') == os.getpid() or not publish_astra.process_alive(owner.get('pid'))
                or owner.get('runtime_commit') != publish_astra.runtime_commit()
                or owner.get('continuation_authorization') != {
                    'path': str(auth_path), 'sha256': luna.sha(auth_path)}
                or owner.get('continuation_plan') != {
                    'path': str(plan_path.resolve()), 'sha256': luna.sha(plan_path)}
                or owner.get('selected_ids_sha256') != self.authorization.get('selected_ids_sha256')
                or owner.get('manifest_sha256') != self.authorization.get('manifest_sha256')
                or owner.get('culled_ids_sha256') != self.authorization.get('culled_ids_sha256')
                or owner.get('lock_path') != str(owner_lock.resolve())
                or not owner.get('created_at')):
            raise ContinuationIntegrityError('Live fixed-subset production owner identity changed')
        if (not publish_astra.lock_is_held(owner_lock) or owner_path.read_bytes() != owner_raw
                or not publish_astra.process_alive(owner['pid'])):
            raise ContinuationIntegrityError('Fixed-subset production owner lock is not continuously held')

    def candidate_pending(self, vid):
        if (getattr(self, 'continuation_scope', None) == FIXED_SUBSET_SCOPE
                and getattr(self, 'continuation', None)
                and vid in validate_preflight_hold_receipt(
                    self.root, self.continuation_authorization.parent, self.continuation, required=False)):
            return False
        row = self.records.get(vid, {})
        if row.get('status') not in TERMINAL:
            return True
        # Only the exact old failed record is eligible for the one authorized
        # recovery. A newly failed recovery remains terminal across restarts.
        proof = getattr(self, 'recovery_proofs', {}).get(vid)
        return bool(proof and row.get('status') == 'failed'
                    and luna.sha(self.root / 'records' / f'{vid}.json') == proof['record_sha256'])

    def fixed_subset_plan(self):
        """Freeze exactly the authorized subset and protect every other ledger byte."""
        self.scope_guard()
        path = self.continuation_authorization.parent / 'continuation-plan.json'
        manifest_hash = luna.sha(self.input / 'manifest.json')
        cull_hash = luna.sha(self.input / 'culled-ids.json')
        auth_hash = luna.sha(self.continuation_authorization)
        wanted = {row['candidate_id']: row for row in self.candidates}
        selected, selected_set = list(self.fixed_subset_ids), set(self.fixed_subset_ids)
        if set(self.records) - set(wanted):
            raise ValueError('Ledger contains candidates outside the frozen manifest')
        if path.exists():
            plan = luna.read(path)
            unsigned = {key: value for key, value in plan.items() if key != 'plan_sha256'}
            if (plan.get('schema_version') != 'snippy-fixed-subset-plan-v1'
                    or plan.get('continuation_id') != self.continuation_id
                    or plan.get('manifest_sha256') != manifest_hash
                    or plan.get('culled_ids_sha256') != cull_hash
                    or plan.get('authorization_sha256') != auth_hash
                    or plan.get('authorized_candidate_ids') != selected
                    or plan.get('selected_ids_sha256') != self.authorization.get('selected_ids_sha256')
                    or plan.get('plan_sha256') != audit.digest(unsigned)):
                raise ValueError('Frozen subset plan identity, authorization, IDs, culls, or manifest changed')
            known = FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES.get(plan.get('continuation_id'), {})
            if (known.get('migrated_plan_file_sha256')
                    and luna.sha(path) != known['migrated_plan_file_sha256']):
                raise ContinuationIntegrityError('Migrated fixed-subset plan raw authority changed')
            validate_mixed_batch_inventories(self.root, plan, verify_files=True)
        else:
            terminal_selected = {vid for vid in selected if not self.candidate_pending(vid)}
            targets = selected_set - terminal_selected
            protected = set(self.records) - targets
            protected_absent = set(wanted) - selected_set - set(self.records)
            assigned, slots, holds, preserved = set(), [], [], {}
            for old in ('experiment-plan.json', 'stream-plan.json', 'runner-config.json', 'checkpoint-paths.json'):
                old_path = self.root / old
                if old_path.exists():
                    preserved[old] = luna.sha(old_path)
            for old_path in sorted((self.root / 'batches').glob('*/batch-plan.json')):
                old = luna.read(old_path)
                ids = old.get('slot_candidate_ids', [])
                paid = old.get('candidate_ids', [])
                if (not 1 <= len(ids) <= 5 or len(ids) != len(set(ids)) or set(ids) - set(wanted)
                        or set(paid) - set(ids)):
                    raise ValueError('Existing paid batch membership is invalid')
                preserved[old_path.relative_to(self.root).as_posix()] = luna.sha(old_path)
                pending = targets.intersection(ids)
                if not pending:
                    continue
                if pending & assigned:
                    raise ValueError('Selected pending candidate is duplicated across frozen paid batches')
                assigned.update(pending)
                if set(ids) - selected_set:
                    for vid in selected:
                        if vid in pending:
                            holds.append({'candidate_id': vid, 'reason': 'mixed_historical_paid_batch',
                                'batch_name': old_path.parent.name, 'batch_plan_sha256': luna.sha(old_path),
                                'detail': 'Selected candidate shares frozen historical paid membership with out-of-scope IDs; no replay or regrouping authorized.'})
                    continue
                resumable = pending.intersection(paid)
                omitted = pending - resumable
                for vid in selected:
                    if vid in omitted:
                        holds.append({'candidate_id': vid, 'reason': 'incomplete_historical_paid_batch',
                            'batch_name': old_path.parent.name, 'batch_plan_sha256': luna.sha(old_path),
                            'detail': 'Selected candidate was omitted from the historical paid-call membership; explicit root review required before any regrouping.'})
                if resumable:
                    slots.append({'batch_name': old_path.parent.name, 'origin': 'existing_selected_paid_batch',
                                  'candidate_ids': ids, 'execution_candidate_ids': [vid for vid in ids if vid in resumable],
                                  'items': [wanted[vid] for vid in ids]})
            # A request/call-state without frozen membership is ambiguous paid
            # state.  Never regroup any selected member around it.
            for batch in (self.root / 'batches').glob('*'):
                if batch.is_dir() and not (batch / 'batch-plan.json').exists() and any(
                        any(batch.rglob(name)) for name in ('call-state.json', 'request.json', 'pipeline-results.json')):
                    raise ValueError('Paid artifacts lack frozen batch membership: ' + batch.name)
            unplanned = targets - assigned
            for lane in ('eligible', 'review'):
                remaining = [wanted[vid] for vid in selected if vid in unplanned and wanted[vid]['lane'] == lane]
                for index in range(0, len(remaining), 5):
                    items = remaining[index:index+5]
                    ids = [row['candidate_id'] for row in items]
                    name = f'{self.continuation_id}-{lane}-{index//5+1:04d}'
                    if (self.root / 'batches' / name).exists():
                        raise ValueError('Fixed subset namespace has artifacts without its authorization plan')
                    slots.append({'batch_name': name, 'origin': 'fixed_subset', 'candidate_ids': ids,
                                  'execution_candidate_ids': ids, 'items': items})
                    assigned.update(ids)
            if assigned != targets:
                raise ValueError('Fixed subset plan does not account for every pending selected candidate')
            batch_names = []
            for hold in holds:
                if hold['batch_name'] not in batch_names:
                    batch_names.append(hold['batch_name'])
            mixed_inventories = [immutable_batch_inventory(self.root, name) for name in batch_names]
            plan = {'schema_version': 'snippy-fixed-subset-plan-v1', 'continuation_id': self.continuation_id,
                    'created_at': audit.now(), 'manifest_sha256': manifest_hash, 'culled_ids_sha256': cull_hash,
                    'authorization_sha256': auth_hash, 'selected_ids_sha256': self.authorization['selected_ids_sha256'],
                    'authorized_candidate_ids': selected, 'authorized_candidate_count': len(selected),
                    'target_candidate_count': len(targets), 'candidate_ids': [vid for vid in selected if vid in targets],
                    'slots': slots, 'preflight_holds': holds,
                    'mixed_batch_inventories': mixed_inventories,
                    'protected_record_sha256': {vid: luna.sha(self.root / 'records' / f'{vid}.json') for vid in sorted(protected)},
                    'protected_absent_ids': sorted(protected_absent),
                    'baseline_record_sha256': {vid: luna.sha(self.root / 'records' / f'{vid}.json') for vid in sorted(self.records)},
                    'preserved_file_sha256': preserved, 'maximum_batch_members': 5, 'maximum_batch_workers': 2,
                    'render_slots': 2, 'asr_slots': 1, 'publication_writers': 1,
                    'min_release_confidence': .95, 'max_passes': luna.MAX_PASSES}
            plan['plan_sha256'] = audit.digest(plan)
            audit.atomic(path, plan)
            saved = luna.read(path)
            if saved != plan or luna.sha(path) == '':
                raise ContinuationIntegrityError('Fixed-subset plan inventory readback failed')
            validate_mixed_batch_inventories(self.root, saved, verify_files=True)
        execution = [vid for slot in plan['slots'] for vid in slot['execution_candidate_ids']]
        held = [row['candidate_id'] for row in plan.get('preflight_holds', [])]
        protected_selected = set(plan['protected_record_sha256']) & selected_set
        if (len(execution + held) != len(set(execution + held))
                or set(execution + held) != set(plan['candidate_ids'])
                or set(plan['candidate_ids']) | protected_selected != selected_set
                or set(plan['candidate_ids']) & protected_selected
                or any(not 1 <= len(slot['candidate_ids']) <= 5
                       or not set(slot['execution_candidate_ids']) <= selected_set & set(slot['candidate_ids'])
                       or slot['items'] != [wanted[vid] for vid in slot['candidate_ids']]
                       or Path(slot['batch_name']).name != slot['batch_name'] for slot in plan['slots'])):
            raise ValueError('Frozen fixed subset candidate membership is invalid')
        validate_fixed_subset_protection_cover(
            plan, wanted, selected_set,
            (record.stem for record in (self.root / 'records').glob('*.json')))
        for vid, digest in plan['protected_record_sha256'].items():
            record = self.root / 'records' / f'{vid}.json'
            if not record.exists() or luna.sha(record) != digest:
                raise ValueError('Protected prior disposition changed: ' + vid)
        for hold in plan.get('preflight_holds', []):
            vid = hold['candidate_id']
            record = self.root / 'records' / f'{vid}.json'
            expected = plan.get('baseline_record_sha256', {}).get(vid)
            if not expected or not record.exists() or luna.sha(record) != expected:
                raise ValueError('Preflight-held prior record changed: ' + vid)
        for vid in plan.get('protected_absent_ids', []):
            if (self.root / 'records' / f'{vid}.json').exists():
                raise ValueError('Out-of-scope record appeared after subset admission: ' + vid)
        for relative, digest in plan['preserved_file_sha256'].items():
            source = (self.root / relative).resolve()
            if not source.is_relative_to(self.root) or not source.exists() or luna.sha(source) != digest:
                raise ValueError('Prior checkpoint or paid batch plan changed: ' + relative)
        validate_mixed_batch_inventories(self.root, plan, verify_files=False)
        self.continuation = plan
        self.continuation_file_sha256 = luna.sha(path)
        return plan

    def continuation_plan(self):
        """Authorize remaining coverage without rewriting any old paid membership."""
        self.validate_continuation_authorization()
        if self.continuation_scope == FIXED_SUBSET_SCOPE:
            return self.fixed_subset_plan()
        path = self.continuation_authorization.parent / 'continuation-plan.json'
        manifest_hash = luna.sha(self.input / 'manifest.json')
        auth_hash = luna.sha(self.continuation_authorization)
        wanted = {row['candidate_id']: row for row in self.candidates}
        if set(self.records) - set(wanted):
            raise ValueError('Ledger contains candidates outside the frozen manifest')
        if path.exists():
            plan = luna.read(path)
            unsigned = {key: value for key, value in plan.items() if key != 'plan_sha256'}
            if (plan.get('continuation_id') != self.continuation_id or plan.get('manifest_sha256') != manifest_hash
                    or plan.get('authorization_sha256') != auth_hash or plan.get('plan_sha256') != audit.digest(unsigned)):
                raise ValueError('Frozen continuation identity, authorization, or manifest changed')
        else:
            recovery = set(self.recovery_proofs)
            if not recovery <= set(wanted) or any(not self.candidate_pending(vid) for vid in recovery):
                raise ValueError('Recovery candidate is missing its original failed record')
            protected = {vid for vid, row in self.records.items() if row['status'] in TERMINAL} - recovery
            targets = set(wanted) - protected
            assigned, slots, preserved = set(), [], {}
            for old in ('experiment-plan.json', 'stream-plan.json', 'runner-config.json', 'checkpoint-paths.json'):
                old_path = self.root / old
                if old_path.exists():
                    preserved[old] = luna.sha(old_path)
            # Every known batch, even a completed one, retains its old frozen plan.
            # Incomplete batches resume from original directories and run_hash so
            # successful and ambiguous paid requests never escape their caches.
            for old_path in sorted((self.root / 'batches').glob('*/batch-plan.json')):
                old = luna.read(old_path)
                ids = old['slot_candidate_ids']
                if (not 1 <= len(ids) <= 5 or len(ids) != len(set(ids)) or set(ids) - set(wanted)
                        or set(old['candidate_ids']) - set(ids)):
                    raise ValueError('Existing paid batch membership is invalid')
                preserved[old_path.relative_to(self.root).as_posix()] = luna.sha(old_path)
                if recovery.intersection(old['candidate_ids']):
                    raise ValueError('Recovery candidate already belongs to a paid request')
                pending = targets.intersection(ids) - recovery
                if pending:
                    if pending - set(old['candidate_ids']) or pending & assigned:
                        raise ValueError('Pending candidate omitted from or duplicated across frozen paid batches')
                    assigned.update(pending)
                    slots.append({'batch_name': old_path.parent.name, 'origin': 'existing_paid_batch',
                                  'candidate_ids': ids, 'execution_candidate_ids': sorted(pending),
                                  'items': [wanted[vid] for vid in ids]})
            # Unplanned directories with paid state cannot be safely regrouped.
            for batch in (self.root / 'batches').glob('*'):
                if batch.is_dir() and not (batch / 'batch-plan.json').exists() and any(
                        any(batch.rglob(name)) for name in ('call-state.json', 'request.json', 'pipeline-results.json')):
                    raise ValueError('Paid artifacts lack frozen batch membership: ' + batch.name)
            recoverable = [row for row in self.candidates if row['candidate_id'] in recovery]
            for index in range(0, len(recoverable), 5):
                items = recoverable[index:index+5]
                ids = [row['candidate_id'] for row in items]
                name = f'{self.continuation_id}-recovery-{index//5+1:04d}'
                if (self.root / 'batches' / name).exists():
                    raise ValueError('Recovery namespace has artifacts without authorization plan')
                slots.append({'batch_name': name, 'origin': 'authorized_local_failure_recovery',
                              'candidate_ids': ids, 'execution_candidate_ids': ids, 'items': items})
                assigned.update(ids)
            for lane in ('eligible', 'review'):
                remaining = [row for row in self.candidates if row['lane'] == lane
                             and row['candidate_id'] in targets - assigned]
                for index in range(0, len(remaining), 5):
                    items = remaining[index:index+5]
                    name = f'{self.continuation_id}-{lane}-{index//5+1:04d}'
                    if (self.root / 'batches' / name).exists():
                        raise ValueError('Continuation namespace has artifacts without authorization plan')
                    ids = [row['candidate_id'] for row in items]
                    slots.append({'batch_name': name, 'origin': 'remaining_manifest',
                                  'candidate_ids': ids, 'execution_candidate_ids': ids, 'items': items})
                    assigned.update(ids)
            if assigned != targets:
                raise ValueError('Continuation does not cover every remaining candidate')
            plan = {'schema_version': 'snippy-full-continuation-v1', 'continuation_id': self.continuation_id,
                    'created_at': audit.now(), 'manifest_sha256': manifest_hash, 'authorization_sha256': auth_hash,
                    'target_candidate_count': len(targets), 'candidate_ids': sorted(targets), 'slots': slots,
                    'recoverable_failed_ids': sorted(recovery),
                    'protected_record_sha256': {vid: luna.sha(self.root / 'records' / f'{vid}.json') for vid in sorted(protected)},
                    'baseline_record_sha256': {vid: luna.sha(self.root / 'records' / f'{vid}.json') for vid in sorted(self.records)},
                    'preserved_file_sha256': preserved, 'maximum_batch_members': 5, 'maximum_batch_workers': 2,
                    'min_release_confidence': .95, 'max_passes': luna.MAX_PASSES}
            plan['plan_sha256'] = audit.digest(plan)
            audit.atomic(path, plan)
        ids = [vid for slot in plan['slots'] for vid in slot['execution_candidate_ids']]
        if (len(ids) != len(set(ids)) or set(ids) != set(plan['candidate_ids'])
                or len(ids) != plan['target_candidate_count']
                or set(plan['candidate_ids']) | set(plan['protected_record_sha256']) != set(wanted)
                or set(plan['candidate_ids']) & set(plan['protected_record_sha256'])
                or any(not 1 <= len(slot['candidate_ids']) <= 5
                       or not set(slot['execution_candidate_ids']) <= set(slot['candidate_ids'])
                       or slot['items'] != [wanted[vid] for vid in slot['candidate_ids']]
                       or Path(slot['batch_name']).name != slot['batch_name'] for slot in plan['slots'])):
            raise ValueError('Frozen continuation candidate membership is invalid')
        for vid, digest in plan['protected_record_sha256'].items():
            record = self.root / 'records' / f'{vid}.json'
            if not record.exists() or luna.sha(record) != digest:
                raise ValueError('Protected prior disposition changed: ' + vid)
        for relative, digest in plan['preserved_file_sha256'].items():
            source = (self.root / relative).resolve()
            if not source.is_relative_to(self.root) or not source.exists() or luna.sha(source) != digest:
                raise ValueError('Prior checkpoint or paid batch plan changed: ' + relative)
        if getattr(self, 'tuning', None) and self.tuning['continuation_plan_sha256'] != plan['plan_sha256']:
            raise ValueError('Batch tuning authorization is bound to a different continuation plan')
        self.continuation = plan
        return plan

    def pause_candidates(self, items, stage):
        for item in items:
            vid = item['candidate_id']
            row = self.records.get(vid)
            if row and row.get('status') not in TERMINAL and row.get('status') != 'paused':
                self.save(vid, 'paused', previous_status=row.get('status'), pause_stage=stage,
                          pause_reason='Operator STOP.json; no new operations admitted', paused_at=audit.now())

    def apply_preflight_holds(self):
        """Dispose unsafe mixed memberships without replay or ledger mutation."""
        if self.continuation_scope != FIXED_SUBSET_SCOPE:
            return
        holds = self.continuation.get('preflight_holds', [])
        if not holds:
            return
        path = self.continuation_authorization.parent / 'preflight-hold-dispositions.json'
        if path.exists():
            validate_preflight_hold_receipt(
                self.root, self.continuation_authorization.parent, self.continuation, required=True,
                verify_mixed_inventory=True)
            return
        self.scope_guard(full=True, verify_mixed_inventory=True)
        rows = []
        for hold in holds:
            vid = hold['candidate_id']
            record = self.root / 'records' / f'{vid}.json'
            packet = self.input / 'candidates' / f'{vid}.json'
            rows.append({'candidate_id': vid, 'effective_status': 'awaiting_astra',
                         'reason': hold['detail'], 'mixed_batch': hold['batch_name'],
                         'mixed_batch_plan_sha256': hold['batch_plan_sha256'],
                         'record_path': str(record.resolve()),
                         'record_sha256': self.continuation['baseline_record_sha256'][vid],
                         'packet_path': str(packet.resolve())})
        receipt = {'schema_version': PREFLIGHT_HOLD_SCHEMA, 'job_id': self.continuation_id,
                   'plan_sha256': self.continuation['plan_sha256'], 'created_at': audit.now(),
                   'holds': rows,
                   'mixed_batch_inventories': self.continuation['mixed_batch_inventories']}
        receipt['receipt_sha256'] = audit.digest(receipt)
        audit.atomic(path, receipt)
        validate_preflight_hold_receipt(
            self.root, self.continuation_authorization.parent, self.continuation, required=True,
            verify_mixed_inventory=True)

    def verify_fixed_subset_local(self):
        """Offline completion gate; cloud readback remains bound in publication receipts."""
        plan = self.fixed_subset_plan()
        rows, errors = [], []
        preflight = validate_preflight_hold_receipt(
            self.root, self.continuation_authorization.parent, plan,
            required=bool(plan.get('preflight_holds')), verify_mixed_inventory=True)
        for vid in plan['authorized_candidate_ids']:
            path = self.root / 'records' / f'{vid}.json'
            row = luna.read(path) if path.exists() else {'candidate_id': vid, 'status': 'unadmitted'}
            status = preflight.get(vid, {}).get('effective_status', row.get('status'))
            rows.append({'candidate_id': vid, 'status': status,
                         'source_record_status': row.get('status'),
                         'record_sha256': luna.sha(path) if path.exists() else None})
            if status not in TERMINAL:
                errors.append({'code': 'selected_candidate_nonterminal', 'candidate_id': vid,
                               'status': status})
            if status in ('published', 'already_published'):
                receipt = artifact_path(self.root, row.get('publication_receipt', ''))
                if not receipt.is_file():
                    errors.append({'code': 'selected_publication_receipt_missing', 'candidate_id': vid})
            elif status == 'awaiting_astra':
                packet = artifact_path(self.root, preflight.get(vid, {}).get(
                    'packet_path', row.get('packet_path', self.input / 'candidates' / f'{vid}.json')))
                if not packet.is_file():
                    errors.append({'code': 'selected_astra_packet_missing', 'candidate_id': vid})
            elif status == 'failed' and not (row.get('error') or row.get('reason')):
                errors.append({'code': 'selected_failure_reason_missing', 'candidate_id': vid})
        result = {'schema_version': 'snippy-fixed-subset-local-verification-v1', 'time': audit.now(),
                  'job_id': self.continuation_id, 'plan_sha256': plan['plan_sha256'],
                  'selected_ids_sha256': plan['selected_ids_sha256'], 'requested': len(rows),
                  'counts': dict(Counter(row['status'] for row in rows)), 'rows': rows,
                  'errors': errors, 'passed': not errors}
        audit.atomic(self.continuation_authorization.parent / 'subset-verification.json', result)
        if errors:
            raise ValueError('Fixed subset local verification failed')
        return result

    def stop_requested(self):
        try:
            luna.check_stop(self.root)
            return False
        except luna.OperationalPause:
            return True

    def save(self, vid, status, **values):
        self.scope_guard(vid)
        with self.lock:
            if getattr(self, 'continuation', None) and vid in self.continuation['protected_record_sha256']:
                raise ContinuationIntegrityError('Continuation cannot rewrite a protected prior disposition: ' + vid)
            if (getattr(self, 'continuation_scope', None) == FIXED_SUBSET_SCOPE
                    and getattr(self, 'continuation', None)
                    and vid in {row['candidate_id'] for row in self.continuation.get('preflight_holds', [])}):
                raise ContinuationIntegrityError('Continuation cannot rewrite a preflight-held prior record: ' + vid)
            row = {**self.records.get(vid, {}), 'candidate_id': vid, 'status': status, 'updated_at': audit.now(), **values}
            audit.atomic(self.root / 'records' / f'{vid}.json', row)
            self.records[vid] = row
            self.last_id = vid
        print(audit.now(), vid, status, flush=True)
        self.heartbeat()

    def heartbeat(self):
        with self.lock:
            # Raw responses include successful API calls even when normalization failed.
            for path in (self.root / 'batches').glob('*/*/response.json'):
                raw = luna.read(path)
                if raw.get('id'):
                    self.responses[raw['id']] = audit.price(raw)
            scoped_ids = (self.fixed_subset_ids if self.continuation_scope == FIXED_SUBSET_SCOPE
                          else [row['candidate_id'] for row in self.candidates])
            preflight = (validate_preflight_hold_receipt(
                self.root, self.continuation_authorization.parent, self.continuation, required=False)
                if self.continuation_scope == FIXED_SUBSET_SCOPE and self.continuation else {})
            scoped_rows = []
            for vid in scoped_ids:
                if vid not in self.records:
                    continue
                row = self.records[vid]
                if vid in preflight:
                    row = {**row, 'source_record_status': row.get('status'),
                           'status': preflight[vid]['effective_status'],
                           'reason': preflight[vid]['reason'],
                           'packet_path': preflight[vid]['packet_path'],
                           'preflight_hold_receipt': str(
                               self.continuation_authorization.parent / 'preflight-hold-dispositions.json')}
                scoped_rows.append(row)
            counts = Counter(r['status'] for r in scoped_rows)
            done = sum(counts[s] for s in TERMINAL)
            current_cost = sum(self.responses.values())
            checkpoint_cost = self.checkpoint_status.get('luna_cost_usd', 0)
            shadow_rows = [row for row in scoped_rows if row.get('checkpoint_origin') != 'Mac']
            source_failures = [row for row in shadow_rows if row['status'] == 'failed' and
                               (row.get('isolated_source_failure') or
                                any(term in str(row.get('error', '')).lower() for term in
                                    ('source generation', 'source not', '403', '404', '410', '412', 'gcs did not honor')))]
            transferred = sum(row.get('transfer', {}).get('upstream_body_bytes_read', 0) for row in shadow_rows)
            requested_bytes = sum(row.get('transfer', {}).get('upstream_requested_bytes', 0) for row in shadow_rows)
            audit.atomic(self.root / 'status.json', {'time': audit.now(), 'pid': os.getpid(), 'machine': self.machine,
                'batch_namespace': self.namespace, 'batch_workers': getattr(self, 'current_batch_workers', self.batch_workers),
                'batch_workers_startup': self.batch_workers,
                'batch_workers_authorized_max': (getattr(self, 'tuning', None) or {}).get('maximum_batch_workers', self.batch_workers),
                'batch_tuning_authorization_sha256': (getattr(self, 'tuning', None) or {}).get('_sha256'),
                'batch_workers_error': getattr(self, 'batch_workers_error', None),
                'continuation_id': getattr(self, 'continuation_id', None),
                'continuation_plan_sha256': (getattr(self, 'continuation', None) or {}).get('plan_sha256'),
                'active_batches': [dict(self.active_batches[name]) for name in sorted(self.active_batches)],
                'phase': self.phase, 'requested': len(scoped_ids), 'covered': done, 'remaining': len(scoped_ids) - done,
                'counts': dict(counts), 'active_ids': sorted(self.active_ids), 'luna_cost_usd': checkpoint_cost + current_cost,
                'checkpoint_luna_cost_usd': checkpoint_cost, 'current_luna_cost_usd': current_cost,
                'unique_api_responses': self.checkpoint_status.get('unique_api_responses', 0) + len(self.responses),
                'current_unique_api_responses': len(self.responses), 'error': self.error,
                'last_id': self.last_id, 'covered_ids': sorted(row['candidate_id'] for row in scoped_rows if row['status'] in TERMINAL),
                'already_published': counts['already_published'], 'newly_published': counts['published'],
                'awaiting_astra': counts['awaiting_astra'], 'source_failed': len(source_failures),
                'other_failed': counts['failed'] - len(source_failures),
                'gcs_body_bytes_read': transferred, 'gcs_requested_bytes_upper_bound': requested_bytes,
                'initial_render_output_bytes': sum(row.get('output_bytes', 0) for row in shadow_rows),
                'storage_provider': 'Google Cloud Storage', 'bucket': 'snippysaurus-clips'})
            audit.atomic(self.continuation_authorization.parent / 'astra-handoff-queue.json' if self.continuation_scope == FIXED_SUBSET_SCOPE
                         else self.root / 'astra-handoff-queue.json', {'time': audit.now(),
                'items': [r for r in scoped_rows if r['status'] == 'awaiting_astra'],
                'operational_failures': [r for r in scoped_rows if r['status'] == 'failed']})
            if getattr(self, 'continuation', None):
                path = self.continuation_authorization.parent / 'continuation-status.json'
                previous = luna.read(path) if path.exists() else {}
                continuation_ids = self.continuation.get('authorized_candidate_ids', self.continuation['candidate_ids'])
                scoped = Counter(
                    preflight[vid]['effective_status'] if vid in preflight
                    else ('recovery_pending' if self.records.get(vid, {}).get('status') == 'failed'
                          and self.candidate_pending(vid)
                          else self.records.get(vid, {}).get('status', 'unadmitted'))
                    for vid in continuation_ids)
                audit.atomic(path, {**previous, 'continuation_id': self.continuation_id,
                    'plan_sha256': self.continuation['plan_sha256'], 'time': audit.now(), 'pid': os.getpid(),
                    'phase': self.phase, 'error': self.error, 'counts': dict(scoped),
                    'target_candidate_count': len(self.continuation['candidate_ids']),
                    'authorized_candidate_count': len(continuation_ids),
                    'covered': sum(scoped[state] for state in TERMINAL),
                    'remaining': sum(count for state, count in scoped.items() if state not in TERMINAL),
                    'active_batches': [dict(self.active_batches[name]) for name in sorted(self.active_batches)]})

    def pulse(self):
        while not self.stop.wait(30):
            try:
                self.heartbeat()
            except Exception as exc:
                print('Heartbeat error:', str(exc), flush=True)

    def isolated_source_failure(self, vid, exc):
        """Exclude only concrete unavailable/short sources from the outage breaker."""
        if isinstance(exc, media.SourceIntegrityError):
            return 'source_container_truncated'
        response = getattr(exc, 'response', None)
        if isinstance(exc, requests.HTTPError) and response is not None and response.status_code in (404, 410):
            return 'source_missing_' + str(response.status_code)
        if str(exc) != 'Output QA failed':
            return None
        try:
            packet = luna.read(self.input / 'candidates' / f'{vid}.json')
            recipe = luna.read(self.root / 'recipes' / f'{vid}.json')
            for directory in (self.root / 'rendered').glob(vid + '-*'):
                if not all((directory / name).exists() for name in ('qa.json', 'recipe.json', 'source.json', 'source-ffprobe.json', 'transfer.json')):
                    continue
                if luna.read(directory / 'recipe.json') != recipe:
                    continue
                source = luna.read(directory / 'source.json')
                if any(str(source.get(key)) != str(packet['gcs_object'][key]) for key in ('bucket', 'name', 'generation', 'size')):
                    continue
                qa = luna.read(directory / 'qa.json').get('checks', {})
                required = {'video', 'audio', 'duration', 'native_dimensions', 'native_fps', 'full_decode'}
                if (not required <= set(qa) or qa.get('duration') is not False
                        or not all(value is True for key, value in qa.items() if key != 'duration')
                        or luna.read(directory / 'transfer.json').get('errors')):
                    continue
                duration = float(luna.read(directory / 'source-ffprobe.json')['format']['duration'])
                if max(edit['end_seconds'] for edit in recipe['edits']) > duration + .3:
                    return 'source_eof_duration_mismatch'
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    def prepare(self, item):
        vid = item['candidate_id']
        try:
            self.scope_guard(vid)
            luna.check_stop(self.root)
            with self.lock:
                self.active_ids.add(vid)
            if shutil.disk_usage(self.root).free < 10 * 1024**3:
                self.save(vid, 'failed', stage='disk_space_low', error='disk_space_low: less than 10 GiB free; no render attempted')
                return None
            recovery = getattr(self, 'recovery_proofs', {}).get(vid)
            admission = {'recovery_attempted_at': audit.now(), 'recovery_prior_record_sha256': recovery['record_sha256']} if recovery and self.records.get(vid, {}).get('status') == 'failed' else {}
            self.save(vid, 'preparing', **admission)
            packet = luna.read(self.input / 'candidates' / f'{vid}.json')
            if audit.digest(packet) != item['packet_sha256']:
                raise ContinuationIntegrityError('Input packet changed since manifest')
            try:
                recipe = seed(packet, self.sources[vid])
            except ValueError as exc:
                self.save(vid, 'awaiting_astra', stage='proposal', reason=str(exc),
                          packet_path=str(self.input / 'candidates' / f'{vid}.json'))
                return None
            valid = media.validate(recipe, packet, self.sources[vid], self.forbidden)
            audit.atomic(self.root / 'recipes' / f'{vid}.json', recipe)
            args = SimpleNamespace(output=self.root / 'rendered', max_transfer_bytes=256 * 1024**2)
            with self.render_slots:
                self.scope_guard(vid, full=True)
                luna.check_stop(self.root)
                cached = self.records.get(vid, {}).get('directory')
                if cached and (Path(cached) / 'result.json').exists():
                    from bounded_window_cache import open_window
                    directory = Path(cached).resolve()
                    if not directory.is_relative_to(self.root):
                        raise ValueError('Prepared media directory is outside this run')
                    open_window(directory, self.input)
                    if audit.digest(luna.read(directory / 'recipe.json')) != audit.digest(recipe):
                        raise ValueError('Prepared recipe differs from its frozen source envelope')
                    media.verify_current_source(packet['gcs_object'])
                    result = luna.read(directory / 'result.json')
                else:
                    result = media.render(args, recipe, packet, valid)
            directory = Path(result['clip_path']).parent
            self.save(vid, 'transcribing', directory=str(directory), transfer=result['transfer'], output_bytes=result['output_bytes'])
            luna.check_stop(self.root)
            luna.ensure_asr(directory, self.whisper)
            luna.check_stop(self.root)
            if not (directory / 'contact.jpg').exists():
                luna.contact_sheet(directory)
            self.save(vid, 'prepared', directory=str(directory))
            return directory
        except luna.OperationalPause:
            self.pause_candidates([item], 'preparation')
            return None
        except ContinuationIntegrityError:
            raise
        except Exception as exc:
            if self.stop_requested():
                self.pause_candidates([item], 'preparation')
                return None
            self.save(vid, 'failed', stage='preparation', error=f'{type(exc).__name__}: {exc}',
                      isolated_source_failure=self.isolated_source_failure(vid, exc))
            return None
        finally:
            with self.lock:
                self.active_ids.discard(vid)

    def batch_slots(self):
        if getattr(self, 'continuation_id', None):
            plan = self.continuation_plan()
            for slot in plan['slots']:
                if any(self.candidate_pending(vid) for vid in slot['execution_candidate_ids']):
                    yield self.root / 'batches' / slot['batch_name'], slot['items']
            return
        if getattr(self, 'stream_id', None):
            plan = self.stream_plan()
            for slot in plan['slots']:
                if any(self.records.get(row['candidate_id'], {}).get('status') not in TERMINAL for row in slot['items']):
                    yield self.root / 'batches' / slot['batch_name'], slot['items']
            return
        for lane in ('eligible', 'review'):
            items = [row for row in self.candidates if row['lane'] == lane]
            for i in range(0, len(items), 5):
                slot = items[i:i+5]
                with self.lock:
                    pending = any(self.records.get(row['candidate_id'], {}).get('status') not in TERMINAL for row in slot)
                if pending:
                    name = f'{lane}-{i//5+1:04d}'
                    batch = self.root / 'batches' / (f'{self.namespace}-{name}' if self.namespace else name)
                    yield batch, slot

    def batch_phase(self, batch, phase):
        with self.lock:
            self.active_batches[batch.name]['phase'] = phase
        self.heartbeat()

    def process_batch(self, batch, slot):
        # The outer process lock excludes other runners. This claim also rejects
        # accidental duplicate submission within this runner before any paid call.
        with self.lock:
            if batch.name in self.batch_claims:
                raise RuntimeError('Batch already submitted in this runner: ' + batch.name)
            self.batch_claims.add(batch.name)
            executable = None
            if getattr(self, 'continuation', None):
                frozen = next(item for item in self.continuation['slots'] if item['batch_name'] == batch.name)
                executable = set(frozen['execution_candidate_ids'])
            group = [row for row in slot if self.candidate_pending(row['candidate_id'])
                     and (executable is None or row['candidate_id'] in executable)]
            self.active_batches[batch.name] = {'name': batch.name, 'phase': 'preparing',
                                               'candidate_ids': [row['candidate_id'] for row in group]}
        stage = 'preparation'
        try:
            if self.review_barrier is not None:
                self.review_barrier.wait(timeout=60)
            luna.check_stop(self.root)
            if not group:
                return True
            self.heartbeat()
            directories = None
            if not (batch / 'batch-plan.json').exists():
                with ThreadPoolExecutor(max_workers=2) as pool:
                    directories = [directory for directory in pool.map(self.prepare, group) if directory]
            luna.check_stop(self.root)
            if directories == []:
                # A proposal hold is a valid disposition, not an operational failure.
                with self.lock:
                    return not any(self.records.get(row['candidate_id'], {}).get('status') == 'failed' for row in group)
            stage = 'luna'
            self.batch_phase(batch, 'luna')
            try:
                plan = bound_batch_plan(batch, [row['candidate_id'] for row in slot], directories, self.input / 'candidates')
            except ValueError as exc:
                if getattr(self, 'continuation', None):
                    raise ContinuationIntegrityError('Frozen paid batch evidence failed: ' + str(exc)) from exc
                raise
            if any(row['candidate_id'] not in plan['candidate_ids'] and self.records.get(row['candidate_id'], {}).get('status') not in TERMINAL for row in group):
                raise ValueError('Nonterminal candidate was not part of frozen paid batch; explicit reconciliation required')
            decision_scope = {row['candidate_id'] for row in group}
            self.scope_guard(full=True)
            for vid in plan['candidate_ids']:
                if vid not in decision_scope:
                    continue
                if self.records.get(vid, {}).get('status') not in TERMINAL:
                    self.save(vid, 'reviewing')
            self.scope_guard(full=True, verify_mixed_inventory=True)
            result = planned_pipeline(plan, batch, self.input / 'candidates', self.whisper)
            self.batch_phase(batch, 'publishing')
            for decision in result['decisions']:
                luna.check_stop(self.root)
                vid = decision['candidate_id']
                if vid not in decision_scope:
                    if (vid in set(plan['candidate_ids'])
                            and self.records.get(vid, {}).get('status') in TERMINAL):
                        continue
                    raise ContinuationIntegrityError('Paid decision is outside the admitted execution scope: ' + vid)
                self.scope_guard(vid)
                if self.records.get(vid, {}).get('status') in TERMINAL:
                    continue
                if decision['status'] != 'pass' or not decision['complete']:
                    self.save(vid, 'awaiting_astra', handoff=decision['astra_escalation_path'], reason=decision.get('reason'))
                    continue
                recipe, clip = Path(decision['recipe_path']), Path(decision['media_path'])
                self.save(vid, 'publishing')
                receipt_path = self.root / 'publications' / f'{vid}.json'
                try:
                    with self.publication_lock:
                        self.scope_guard(vid, full=True, verify_mixed_inventory=True)
                        luna.check_stop(self.root)
                        if getattr(self, 'continuation_scope', None) == FIXED_SUBSET_SCOPE:
                            publish_astra.publish(recipe, clip, recipe.parent / 'final-qa.json', receipt_path,
                                scope_plan=self.continuation_authorization.parent / 'continuation-plan.json',
                                scope_authorization=self.continuation_authorization)
                        else:
                            publish_astra.publish(recipe, clip, recipe.parent / 'final-qa.json', receipt_path)
                        live_receipt(luna.read(receipt_path))
                        self.save(vid, 'published', publication_receipt=str(receipt_path), final_directory=str(recipe.parent))
                except luna.OperationalPause:
                    raise
                except Exception as exc:
                    if self.stop_requested():
                        raise luna.OperationalPause('Publication interrupted during operator pause') from exc
                    self.save(vid, 'failed', stage='publication', error=f'{type(exc).__name__}: {exc}', retry_recipe=str(recipe), retry_media=str(clip))
            with self.lock:
                return not any(self.records[row['candidate_id']]['status'] == 'failed' for row in group)
        except luna.OperationalPause:
            self.pause_candidates(group, stage)
            return True
        except ContinuationIntegrityError:
            self.pause_candidates(group, 'integrity_failure')
            raise
        except Exception as exc:
            if self.stop_requested():
                self.pause_candidates(group, stage)
                return True
            for item in group:
                vid = item['candidate_id']
                if self.records.get(vid, {}).get('status') not in TERMINAL:
                    self.save(vid, 'failed', stage=stage, error=f'{type(exc).__name__}: {exc}', batch=str(batch))
            return False
        finally:
            with self.lock:
                self.active_batches.pop(batch.name, None)
            self.heartbeat()

    def target_batch_workers(self):
        """Live whole-batch overlap target; never above the authorized cap.

        Lowering it only stops new admissions; accepted batches drain normally.
        A missing control keeps the startup value; an invalid one falls back
        to the frozen continuation default of two and is reported in status.
        """
        tuning = getattr(self, 'tuning', None)
        if not tuning:
            return self.batch_workers
        path = Path(tuning['control_path'])
        target, error = self.batch_workers, None
        if path.exists():
            try:
                control = luna.read(path)
                value = control.get('batch_workers')
                if (control.get('continuation_id') != self.continuation_id or type(value) is not int
                        or not 1 <= value <= tuning['maximum_batch_workers']):
                    raise ValueError('out of range or wrong continuation')
                target = value
            except (OSError, ValueError) as exc:
                target, error = min(2, self.batch_workers), f'Invalid batch worker control ignored: {exc}'
        if target != self.current_batch_workers or error != self.batch_workers_error:
            with self.lock:
                entry = {'time': audit.now(), 'from': self.current_batch_workers, 'to': target, 'error': error,
                         'active_batches': sorted(self.active_batches), 'pid': os.getpid()}
                with (path.parent / 'batch-workers-applied.jsonl').open('a', encoding='utf-8') as stream:
                    stream.write(json.dumps(entry) + '\n')
                self.current_batch_workers, self.batch_workers_error = target, error
            print(audit.now(), 'batch_workers', entry['from'], '->', target, error or '', flush=True)
        return target

    def run_batches(self):
        """Keep the authorized number of whole batches in flight; drain on a failure stop."""
        slots = iter(self.batch_slots())
        completed = queue.Queue()
        active = set()
        submitted = failures = 0
        exhausted = False
        stop_error = None
        paused = False
        tuning = getattr(self, 'tuning', None)
        capacity = tuning['maximum_batch_workers'] if tuning else self.batch_workers
        with ThreadPoolExecutor(max_workers=capacity) as pool:
            while True:
                while not stop_error and not exhausted and len(active) < self.target_batch_workers():
                    if self.stop_requested():
                        paused = True
                        break
                    if self.limit is not None and submitted >= self.limit:
                        break
                    try:
                        batch, slot = next(slots)
                    except StopIteration:
                        exhausted = True
                        break
                    def process(batch=batch, slot=slot):
                        succeeded = self.process_batch(batch, slot)
                        if succeeded or not getattr(self, 'continuation_id', None):
                            return succeeded
                        failed = [self.records.get(item['candidate_id'], {}) for item in slot
                                  if self.records.get(item['candidate_id'], {}).get('status') == 'failed']
                        # A bad/missing source is an isolated terminal skip. Every
                        # unclassified, provider, auth, ASR, or publication failure
                        # retains the existing three-consecutive-batch breaker.
                        return bool(failed) and all(row.get('stage') == 'preparation' and row.get('isolated_source_failure')
                                                    in ('source_missing_404', 'source_missing_410',
                                                        'source_eof_duration_mismatch', 'source_container_truncated')
                                                    for row in failed)
                    future = pool.submit(process)
                    active.add(future)
                    future.add_done_callback(completed.put)
                    submitted += 1
                if not active:
                    break
                try:
                    # Tuned runs re-read the live overlap target while waiting.
                    future = completed.get(timeout=5 if tuning else None)
                except queue.Empty:
                    continue
                active.remove(future)
                try:
                    succeeded = future.result()
                except ContinuationIntegrityError as exc:
                    succeeded = False
                    stop_error = 'Immutable continuation integrity failure: ' + str(exc)
                    self.phase, self.error = 'draining_after_integrity_failure', stop_error
                    self.heartbeat()
                except Exception as exc:
                    succeeded = False
                    self.error = f'{type(exc).__name__}: {exc}'
                failures = 0 if succeeded else failures + 1
                if failures >= 3 and stop_error is None:
                    stop_error = 'Three consecutive batch failures; stopped scheduling and drained active work before resume'
                    self.phase = 'draining_after_batch_failures'
                    self.error = stop_error
                    self.heartbeat()
        if paused or self.stop_requested():
            raise luna.OperationalPause('Operator stop requested; active batches drained')
        if stop_error:
            raise RuntimeError(stop_error)
        return exhausted

    def experiment_plan(self):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', self.experiment_id):
            raise ValueError('Experiment ID must be a simple name of at most 80 characters')
        path = self.root / 'experiment-plan.json'
        manifest_hash = luna.sha(self.input / 'manifest.json')
        if path.exists():
            plan = luna.read(path)
            bound = {key: value for key, value in plan.items() if key != 'plan_sha256'}
            if (plan.get('experiment_id') != self.experiment_id or plan.get('manifest_sha256') != manifest_hash
                    or plan.get('plan_sha256') != audit.digest(bound)):
                raise ValueError('Frozen experiment identity or input manifest changed')
        else:
            # Fresh means never admitted to the ledger, not merely nonterminal.
            fresh, slots = [], []
            for lane, count in (('eligible', 35), ('review', 15)):
                selected = [row for row in self.candidates if row['lane'] == lane and row['candidate_id'] not in self.records][:count]
                if len(selected) != count:
                    raise ValueError(f'Exactly {count} fresh {lane} candidates are required for this experiment')
                fresh.extend(selected)
                slots.extend({'batch_name': f'{self.experiment_id}-{lane}-{i//5+1:04d}', 'lane': lane,
                              'candidate_ids': [row['candidate_id'] for row in selected[i:i+5]], 'items': selected[i:i+5]}
                             for i in range(0, count, 5))
            baseline_response_ids = set(self.responses)
            for response_path in (self.root / 'mac-checkpoint' / 'batches').glob('*/*/response.json'):
                response_id = luna.read(response_path).get('id')
                if response_id:
                    baseline_response_ids.add(response_id)
            plan = {'schema_version': 'snippy-bounded-experiment-v1', 'experiment_id': self.experiment_id,
                    'created_at': audit.now(), 'target_batch_count': 10, 'target_candidate_count': 50,
                    'candidate_ids': [row['candidate_id'] for row in fresh], 'slots': slots,
                    'manifest_sha256': manifest_hash,
                    'baseline_covered_ids': sorted(vid for vid, row in self.records.items() if row['status'] in TERMINAL),
                    'baseline_counts': dict(Counter(row['status'] for row in self.records.values())),
                    'baseline_record_sha256': {path.stem: luna.sha(path) for path in (self.root / 'records').glob('*.json')},
                    'baseline_response_ids': sorted(baseline_response_ids),
                    'baseline_mac_cost_usd': self.checkpoint_status.get('luna_cost_usd', 0),
                    'baseline_shadow_cost_usd': sum(self.responses.values()),
                    'baseline_luna_cost_usd': self.checkpoint_status.get('luna_cost_usd', 0) + sum(self.responses.values())}
            plan['plan_sha256'] = audit.digest(plan)
            audit.atomic(path, plan)
        ids = [vid for slot in plan['slots'] for vid in slot['candidate_ids']]
        manifest_items = {row['candidate_id']: row for row in self.candidates}
        if (len(plan['slots']) != 10 or any(len(slot['candidate_ids']) != 5 for slot in plan['slots'])
                or len(ids) != len(set(ids)) or len(ids) != 50 or ids != plan['candidate_ids']
                or [slot['batch_name'] for slot in plan['slots']] !=
                   [f'{self.experiment_id}-eligible-{i:04d}' for i in range(1, 8)] +
                   [f'{self.experiment_id}-review-{i:04d}' for i in range(1, 4)]
                or [slot['lane'] for slot in plan['slots']] != ['eligible'] * 7 + ['review'] * 3
                or any(slot['items'] != [manifest_items[vid] for vid in slot['candidate_ids']] for slot in plan['slots'])):
            raise ValueError('Frozen experiment membership is invalid')
        return plan

    def stream_plan(self):
        """Freeze one tiny fresh admission; restart can never select replacements."""
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', self.stream_id):
            raise ValueError('Stream ID must be a simple name of at most 80 characters')
        path = self.root / 'stream-plan.json'
        manifest_hash = luna.sha(self.input / 'manifest.json')
        if path.exists():
            plan = luna.read(path)
            unsigned = {key: value for key, value in plan.items() if key != 'plan_sha256'}
            if (plan.get('stream_id') != self.stream_id or plan.get('target_candidate_count') != self.max_candidates
                    or plan.get('manifest_sha256') != manifest_hash or plan.get('plan_sha256') != audit.digest(unsigned)):
                raise ValueError('Frozen streaming identity, limit, or manifest changed')
        else:
            excluded = set(self.records)
            previous_path = self.root / 'experiment-plan.json'
            if previous_path.exists():
                previous = luna.read(previous_path)
                if previous.get('plan_sha256') != audit.digest({k: v for k, v in previous.items() if k != 'plan_sha256'}):
                    raise ValueError('Previous experiment plan hash changed')
                excluded.update(previous['candidate_ids'])
            slots = []
            for lane, count in (('eligible', (self.max_candidates + 1)//2), ('review', self.max_candidates//2)):
                if not count:
                    continue
                fresh = [row for row in self.candidates if row['lane'] == lane and row['candidate_id'] not in excluded][:count]
                if len(fresh) != count:
                    raise ValueError('Insufficient fresh mixed-lane candidates for frozen streaming trial')
                name = f'{self.stream_id}-{lane}-0001'
                if (self.root / 'batches' / name).exists():
                    raise ValueError('Streaming namespace already contains artifacts without a frozen plan')
                slots.append({'batch_name': name, 'lane': lane, 'items': fresh,
                              'candidate_ids': [row['candidate_id'] for row in fresh]})
            plan = {'schema_version': 'snippy-small-stream-v1', 'stream_id': self.stream_id, 'created_at': audit.now(),
                    'target_candidate_count': self.max_candidates, 'maximum_candidates': 5,
                    'candidate_ids': [vid for slot in slots for vid in slot['candidate_ids']], 'slots': slots,
                    'excluded_prior_candidate_ids': sorted(excluded), 'manifest_sha256': manifest_hash,
                    'baseline_record_sha256': {path.stem: luna.sha(path) for path in (self.root / 'records').glob('*.json')}}
            plan['plan_sha256'] = audit.digest(plan)
            audit.atomic(path, plan)
        ids = [vid for slot in plan['slots'] for vid in slot['candidate_ids']]
        wanted = {row['candidate_id']: row for row in self.candidates}
        if (len(ids) != self.max_candidates or len(ids) != len(set(ids)) or ids != plan['candidate_ids']
                or set(ids) & set(plan.get('excluded_prior_candidate_ids', []))
                or any(not 1 <= len(slot['candidate_ids']) <= 5
                       or slot['items'] != [wanted[vid] for vid in slot['candidate_ids']] for slot in plan['slots'])):
            raise ValueError('Frozen streaming candidate membership is invalid')
        for vid, digest in plan['baseline_record_sha256'].items():
            record = self.root / 'records' / f'{vid}.json'
            if not record.exists() or luna.sha(record) != digest:
                raise ValueError('Streaming baseline record changed: ' + vid)
        if set(self.records) - set(ids) - set(plan['baseline_record_sha256']):
            raise ValueError('Ledger grew outside the frozen streaming admission')
        return plan

    def prepare_experiment_batch(self, batch, slot):
        group = [row for row in slot if self.records.get(row['candidate_id'], {}).get('status') not in TERMINAL]
        if not group:
            return
        try:
            if (batch / 'batch-plan.json').exists():
                bound_batch_plan(batch, [row['candidate_id'] for row in slot], None, self.input / 'candidates')
                return
            with ThreadPoolExecutor(max_workers=2) as pool:
                directories = [directory for directory in pool.map(self.prepare, group) if directory]
            luna.check_stop(self.root)
            if directories:
                bound_batch_plan(batch, [row['candidate_id'] for row in slot], directories, self.input / 'candidates')
        except luna.OperationalPause:
            self.pause_candidates(group, 'experiment_preparation')
        except Exception as exc:
            for row in group:
                vid = row['candidate_id']
                if self.records.get(vid, {}).get('status') not in TERMINAL:
                    self.save(vid, 'failed', stage='experiment_preparation', error=f'{type(exc).__name__}: {exc}')

    def run_experiment(self):
        self.heartbeat()
        plan = self.experiment_plan()
        path = self.root / 'experiment-status.json'
        status = luna.read(path) if path.exists() else {'experiment_id': self.experiment_id,
                                                       'started_at': audit.now(), 'attempts': []}
        if status['experiment_id'] != self.experiment_id:
            raise ValueError('Experiment status identity differs from frozen plan')
        attempt = {'pid': os.getpid(), 'started_at': audit.now()}
        status['attempts'].append(attempt)

        def phase(name, timestamp):
            now = audit.now()
            self.phase = name
            attempt[timestamp] = now
            status.update(phase=name, pid=os.getpid())
            if timestamp not in status or timestamp.endswith('finished_at'):
                status[timestamp] = now
            audit.atomic(path, status)
            self.heartbeat()

        work = [(self.root / 'batches' / slot['batch_name'], slot['items']) for slot in plan['slots']]
        if self.stop_requested():
            phase('paused', 'drained_at')
            return
        phase('experiment_preparing', 'preparation_started_at')
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda pair: self.prepare_experiment_batch(*pair), work))
        if self.stop_requested():
            self.pause_candidates([item for _, items in work for item in items], 'preparation')
            phase('paused', 'drained_at')
            return
        phase('experiment_prepared', 'preparation_finished_at')
        # No new IDs are admitted. Every selected preparation has settled before
        # ten workers are released together, including groups held before review.
        self.review_barrier = threading.Barrier(10)
        phase('experiment_reviewing', 'review_started_at')
        try:
            with ThreadPoolExecutor(max_workers=10) as pool:
                outcomes = list(pool.map(lambda pair: self.process_batch(*pair), work))
        finally:
            self.review_barrier = None
        if self.stop_requested():
            self.pause_candidates([item for _, items in work for item in items], 'luna_or_publication')
            phase('paused', 'drained_at')
            return
        phase('experiment_review_finished', 'review_finished_at')
        status['batch_outcomes'] = outcomes
        status['remaining_queue_paused_for_cost_confirmation'] = True
        phase('experiment_completed', 'finished_at')

    def run(self):
        if self.continuation_plan_only:
            raise ContinuationIntegrityError('Plan-only runner cannot execute production')
        # Validate immutable authorization and all protected checkpoint bytes
        # before preflight queries, imports, candidate writes, or paid work.
        continuation_plan = self.continuation_plan() if self.continuation_id else None
        if continuation_plan:
            self.apply_preflight_holds()
            path = self.continuation_authorization.parent / 'continuation-status.json'
            status = luna.read(path) if path.exists() else {'started_at': audit.now(), 'attempts': []}
            status.setdefault('attempts', [])
            status['attempts'].append({'pid': os.getpid(), 'started_at': audit.now()})
            audit.atomic(path, status)
        thread = threading.Thread(target=self.pulse, daemon=True)
        thread.start()
        try:
            luna.check_stop(self.root)
            stream_plan = self.stream_plan() if self.stream_id else None
            admission = continuation_plan or stream_plan
            admitted_ids = (set(admission.get('authorized_candidate_ids', admission['candidate_ids']))
                            if admission else None)
            self.phase = 'verifying_previous_publications'
            for vid, receipt in self.prior.items():
                luna.check_stop(self.root)
                if self.records.get(vid, {}).get('status') in TERMINAL:
                    continue
                if admitted_ids is not None and vid not in admitted_ids:
                    continue
                live_receipt(receipt)
                path = self.root / 'publications' / f'{vid}.json'
                audit.atomic(path, receipt)
                self.save(vid, 'already_published', publication_receipt=str(path))
            # Fail closed on any unexpected existing Astra record; never duplicate it.
            luna.check_stop(self.root)
            self.scope_guard(full=True)
            query_job = audit.bq_client().query(
                "SELECT DISTINCT original_video_id FROM `youtubetranscripts-429803.reptranscripts.snippets_auto` WHERE provider='astra'")
            existing = {row['original_video_id'] for row in query_job.result()}
            receipt_path = self.root / 'preflight-query.json'
            jobs = luna.read(receipt_path).get('query_jobs', []) if receipt_path.exists() else []
            if query_job.job_id not in {job['job_id'] for job in jobs}:
                jobs.append({'job_id': query_job.job_id, 'bytes_billed': query_job.total_bytes_billed or 0,
                             'cache_hit': query_job.cache_hit, 'time': audit.now()})
            audit.atomic(receipt_path, {'query_jobs': jobs, 'time': audit.now()})
            for vid in existing - set(self.prior):
                if admitted_ids is not None and vid not in admitted_ids:
                    continue
                if vid in self.sources and self.records.get(vid, {}).get('status') not in TERMINAL:
                    self.save(vid, 'failed', stage='existing_publication', error='Untracked prior publication requires reconciliation')
            if self.experiment_id:
                self.run_experiment()
                return
            self.phase = 'processing_batches'
            if continuation_plan:
                self.phase = 'continuation_processing'
            if self.stream_id:
                plan = stream_plan
                self.limit = None  # The immutable stream slots are the admission bound.
                status_path = self.root / 'stream-status.json'
                status = luna.read(status_path) if status_path.exists() else {
                    'stream_id': self.stream_id, 'started_at': audit.now(), 'candidate_ids': plan['candidate_ids'], 'attempts': []}
                if status['stream_id'] != self.stream_id:
                    raise ValueError('Stream status identity differs from frozen plan')
                status['attempts'].append({'pid': os.getpid(), 'started_at': audit.now()})
                status['phase'] = 'streaming'
                audit.atomic(status_path, status)
            if not self.run_batches():
                self.phase = 'batch_limit_reached'
                return
            if self.stream_id:
                self.phase = 'stream_completed'
                status.update(phase=self.phase, finished_at=audit.now(),
                    counts=dict(Counter(self.records.get(vid, {}).get('status', 'pending') for vid in plan['candidate_ids'])))
                audit.atomic(status_path, status)
                return
            if continuation_plan:
                # Recheck every protected baseline and original paid batch plan.
                self.continuation_plan()
                execution_ids = [vid for slot in continuation_plan['slots']
                                 for vid in slot['execution_candidate_ids']]
                preflight_holds = continuation_plan.get('preflight_holds', [])
                preflight = (validate_preflight_hold_receipt(
                    self.root, self.continuation_authorization.parent, continuation_plan,
                    required=bool(preflight_holds))
                    if self.continuation_scope == FIXED_SUBSET_SCOPE else {})
                if (any(self.candidate_pending(vid) for vid in execution_ids)
                        or (self.continuation_scope == FIXED_SUBSET_SCOPE
                            and len(preflight) != len(preflight_holds))):
                    raise ValueError('Continuation exhausted its slots without complete candidate dispositions')
                self.phase = 'continuation_completed'
                path = self.continuation_authorization.parent / 'continuation-status.json'
                status = luna.read(path)
                status.update(finished_at=audit.now(), phase=self.phase)
                audit.atomic(path, status)
                if self.continuation_scope == FIXED_SUBSET_SCOPE:
                    self.verify_fixed_subset_local()
                else:
                    verify(self.root)
                return
            self.phase = 'coverage_finished'
            verify(self.root)
        except luna.OperationalPause:
            self.phase, self.error = 'paused', None
            audit.atomic(self.root / 'pause-status.json', {'phase': 'paused', 'drained_at': audit.now(),
                'reason': 'Operator STOP.json; in-flight operations finished before return',
                'stream_id': self.stream_id, 'experiment_id': self.experiment_id,
                'continuation_id': self.continuation_id})
            if continuation_plan:
                path = self.continuation_authorization.parent / 'continuation-status.json'
                status = luna.read(path)
                status.update(phase='paused', drained_at=audit.now())
                audit.atomic(path, status)
            if self.stream_id:
                path = self.root / 'stream-status.json'
                status = luna.read(path) if path.exists() else {'stream_id': self.stream_id}
                status.update(phase='paused', drained_at=audit.now())
                audit.atomic(path, status)
        except Exception as exc:
            self.phase, self.error = 'stopped_on_error', f'{type(exc).__name__}: {exc}'
            raise
        finally:
            self.stop.set()
            self.heartbeat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('.context/astra-clips/production-1644'))
    parser.add_argument('--whisper-cli', default='whisper' if os.name == 'nt' else '/opt/homebrew/bin/whisper')
    parser.add_argument('--machine', default='Shadow' if os.name == 'nt' else 'Mac')
    parser.add_argument('--batch-namespace')
    parser.add_argument('--private-env-file', type=Path)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--max-batches', type=int)
    parser.add_argument('--batch-workers', type=int, choices=range(1, 11), default=1)
    parser.add_argument('--experiment-id')
    parser.add_argument('--stream-id')
    parser.add_argument('--max-candidates', type=int, choices=range(1, 6))
    parser.add_argument('--continuation-id')
    parser.add_argument('--continuation-authorization', type=Path)
    parser.add_argument('--continuation-plan-only', action='store_true', help='Freeze/verify admission without network or execution')
    parser.add_argument('--tuning-authorization', type=Path, help='Hash-bound batch-overlap authorization (continuation only)')
    args = parser.parse_args()
    if args.private_env_file:
        private_environment(args.private_env_file)
    if args.verify:
        result = verify(args.root)
        print(json.dumps(result, indent=2))
        raise SystemExit(0 if result['passed'] else 1)
    args.root.mkdir(parents=True, exist_ok=True)
    with runner_lock(args.root / 'runner.lock'):
        runner = Runner(args.root, args.whisper_cli, args.max_batches, args.machine, args.batch_namespace, args.batch_workers,
                        args.experiment_id, args.stream_id, args.max_candidates, args.continuation_id, args.continuation_authorization,
                        args.tuning_authorization, args.continuation_plan_only)
        if args.continuation_plan_only:
            if not args.continuation_id:
                parser.error('--continuation-plan-only requires --continuation-id and --continuation-authorization')
            plan = runner.continuation_plan()
            print(json.dumps({'plan_sha256': plan['plan_sha256'], 'target_candidate_count': plan['target_candidate_count'],
                              'batch_tuning_max': (runner.tuning or {}).get('maximum_batch_workers'),
                              'slot_count': len(plan['slots']), 'protected_prior_records': len(plan['protected_record_sha256'])}))
        else:
            runner.run()


if __name__ == '__main__':
    main()
