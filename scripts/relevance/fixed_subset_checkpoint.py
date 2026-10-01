#!/usr/bin/env python3
"""Build an immutable checkpoint containing only a frozen fixed subset.

The live production tree is read-only. The checkpoint contains fixed authority,
selected-only records/receipts, and only the batch directories named by the
fixed plan. New fallback cases may receive a lossless FLAC of their complete
current clip; video bytes are never copied.
"""
import argparse
from collections import defaultdict
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

import audit
from checkpoint_shadow import reject_secrets, reject_text_secrets
from production import validate_preflight_hold_receipt


FALLBACK_STATUSES = {'awaiting_astra', 'failed', 'paused'}
SELECTED_RECEIPT_DIRS = ('publications', 'publication-attempts', 'recipes')
STATE_NAME = 'fixed-subset-checkpoint-state.json'
CONTINUATION_FILES = (
    'authorization.json', 'selected-ids.txt', 'preflight-reconciliation.json',
    'preflight-reconciliation.md', 'preflight-hold-dispositions.json',
    'continuation-plan.json', 'continuation-status.json',
    'status.json', 'control-state.json', 'remote-control-history.json',
    'admission-approved.json', 'final-verification.json', 'final-verification.md',
    'final-dispositions.csv', 'code-verification.json', 'production-owner.json', STATE_NAME,
)
METADATA_SUFFIXES = {'.json', '.jsonl', '.md', '.csv', '.log', '.txt', '.jpg', '.png'}
MEDIA_SUFFIXES = {'.mp4', '.mov', '.mkv', '.webm', '.m4a', '.mp3', '.wav', '.flac', '.aac'}
UNSAFE_BATCH_FILES = {'request.json', 'packages.json'}
PRIOR_FALLBACK_DELIVERIES = (
    {
        'job_id': 'SNIPPY-340-ASTRA-EVIDENCE-20261001',
        'response_id': 'R-def2f8713ba2a9cf',
        'asset': 'relay-response-snippy-340-astra-evidence-20261001-89aa3c49982da9ad',
        'bundle_sha256': '89aa3c49982da9ad3ebde8f8223577e0bfa9cc6bc6194aa56e975ad781bee417',
        'receipt_manifest_sha256': '0e62e273cc2eef579d71b2f5792ddaecba9f96e0ca170d7bbfc3ffc410a01d52',
        'acknowledged': True,
        'candidate_ids': ['QEGjCcU0FLs', 'QTaeZhgX_zs', 'Qcf_cZbhSWY', 'QkgHbVoz6N0',
            'QmzNcBaOkfU', 'R78mbtNeCvM', 'RWH4GXIUiXE', 'SsGShgdJdcY', 'SxmcmoslLmA',
            'T8tHmQiYzVA', 'TfQb8iFw7Z0', 'TtPnMIhkqVs', 'TyKPMSJLGmc', 'UOxR4cy1NZ4',
            'V7Q3DJ9V5CQ'],
    },
    {
        'job_id': 'SNIPPY-SELECTED340-LUNA-20261001',
        'response_id': None,
        'asset': 'relay-fixed340-early-frozen-20261001-d807593b1e32c4cf',
        'bundle_sha256': 'd807593b1e32c4cfe49ebb32bf28208d7e52f2d4af6a4161a19b914c2e497979',
        'receipt_manifest_sha256': '97c37b7f256d587a188d05cf6bcf1a15848c2049a3f865fa7f664c95e7d201fb',
        'acknowledged': False,
        'consumer_verified_at': '2026-10-01T11:29:14Z',
        'candidate_ids': ['VZ-JUZMW_bs'],
    },
)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def stable_bytes(path):
    """Read one stable version without locking or changing the source tree."""
    path = Path(path)
    for _ in range(3):
        before = path.stat()
        data = path.read_bytes()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns):
            return data
    raise RuntimeError('Artifact changed repeatedly during fixed-subset checkpoint: ' + str(path))


def checked_source(base, source):
    base, source = Path(base).resolve(), Path(source).resolve()
    if not source.is_file() or not source.is_relative_to(base):
        raise ValueError('Checkpoint source escapes its allowed root: ' + str(source))
    current = source
    while current != base:
        if current.is_symlink() or getattr(current, 'is_junction', lambda: False)():
            raise ValueError('Symlink/junction in checkpoint source: ' + str(source))
        current = current.parent
    return source


def validate_bytes(source, data):
    suffix = Path(source).suffix.lower()
    if suffix == '.json':
        reject_secrets(json.loads(data.decode('utf-8-sig')))
    elif suffix == '.jsonl':
        for line in data.decode('utf-8-sig').splitlines():
            if line.strip():
                reject_secrets(json.loads(line))
    elif suffix in {'.md', '.txt', '.csv', '.log'}:
        reject_text_secrets(data)


def copy_checked(source, target, allowed_root=None):
    source, target = Path(source), Path(target)
    if allowed_root is not None:
        source = checked_source(allowed_root, source)
    data = stable_bytes(source)
    validate_bytes(source, data)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def inside(root, value):
    if not value:
        return None
    path = Path(value).resolve()
    return path if path.is_relative_to(Path(root).resolve()) else None


def baseline_delivery_evidence(selected):
    """Only explicit prior Relay receipts may suppress fallback media."""
    evidence = []
    for item in PRIOR_FALLBACK_DELIVERIES:
        ids = [vid for vid in item['candidate_ids'] if vid in selected]
        if ids:
            evidence.append({**item, 'candidate_ids': ids})
    return evidence


def delivery_state(continuation, auth, preflight, selected):
    path = Path(continuation) / STATE_NAME
    evidence = baseline_delivery_evidence(selected)
    baseline = sorted({vid for item in evidence for vid in item['candidate_ids']})
    if path.exists():
        state = load(path)
    else:
        state = {'schema_version': 'snippy-fixed-subset-checkpoint-state-v1',
            'job_id': auth['job_id'], 'selected_ids_sha256': auth['selected_ids_sha256'],
            'baseline_delivered_fallback_ids': baseline,
            'baseline_delivery_evidence': evidence,
            'delivered_fallback_ids': baseline, 'deliveries': []}
        state['state_sha256'] = audit.digest(state)
    unsigned = {key: value for key, value in state.items() if key != 'state_sha256'}
    if (state.get('schema_version') != 'snippy-fixed-subset-checkpoint-state-v1'
            or state.get('job_id') != auth['job_id']
            or state.get('selected_ids_sha256') != auth['selected_ids_sha256']
            or sorted(state.get('baseline_delivered_fallback_ids', [])) != baseline
            or state.get('baseline_delivery_evidence') != evidence
            or state.get('state_sha256') != audit.digest(unsigned)):
        raise ValueError('Fixed-subset checkpoint delivery state is invalid or stale')
    delivered = state.get('delivered_fallback_ids')
    if (not isinstance(delivered, list) or len(delivered) != len(set(delivered))
            or not set(delivered).issubset(selected)):
        raise ValueError('Fixed-subset delivered fallback inventory is invalid')
    observed = set(baseline)
    for delivery in state.get('deliveries', []):
        directory = Path(delivery.get('directory', '')).resolve()
        manifest_path = directory / 'checkpoint-manifest.json'
        new_ids = delivery.get('new_fallback_ids', [])
        if (not isinstance(new_ids, list) or len(new_ids) != len(set(new_ids))
                or not set(new_ids).issubset(selected) or not manifest_path.is_file()
                or sha(manifest_path) != delivery.get('manifest_file_sha256')):
            raise ValueError('Fixed-subset checkpoint delivery receipt is invalid')
        manifest = load(manifest_path)
        partition_path = directory / 'partition.json'
        if (manifest.get('job_id') != auth['job_id'] or not partition_path.is_file()
                or load(partition_path).get('new_fallback_ids_in_this_checkpoint') != new_ids):
            raise ValueError('Fixed-subset checkpoint delivery contents differ from state')
        observed.update(new_ids)
    if set(delivered) != observed:
        raise ValueError('Fixed-subset delivered fallback set lacks a receipt')
    return state


def mark_delivered(continuation, result):
    """Commit fallback delivery state only after Relay accepted the bundle."""
    continuation = Path(continuation).resolve()
    auth = load(continuation / 'authorization.json')
    preflight = load(continuation / 'preflight-reconciliation.json')
    selected = set((continuation / auth['selected_ids_file']).read_text(encoding='ascii').splitlines())
    state = delivery_state(continuation, auth, preflight, selected)
    if (result.get('job_id') != auth['job_id']
            or result.get('selected_ids_sha256') != auth['selected_ids_sha256']):
        raise ValueError('Cannot record delivery from a different fixed scope')
    new_ids = result.get('new_fallback_ids', [])
    if not isinstance(new_ids, list) or not set(new_ids).issubset(selected):
        raise ValueError('Checkpoint returned an invalid fallback inventory')
    state['delivered_fallback_ids'] = sorted(set(state['delivered_fallback_ids']) | set(new_ids))
    state['deliveries'].append({
        'delivered_at': audit.now(), 'directory': result['directory'],
        'manifest_file_sha256': result['manifest_file_sha256'],
        'new_fallback_ids': new_ids, 'final': bool(result.get('final')),
    })
    state.pop('state_sha256', None)
    state['state_sha256'] = audit.digest(state)
    audit.atomic(continuation / STATE_NAME, state)
    return state


def current_media(root, record):
    """Locate the hash-bound current clip for a fallback without changing it."""
    root = Path(root).resolve()
    candidates, handoff_data = [], None
    handoff = inside(root, record.get('handoff'))
    if handoff:
        handoff_json = handoff.with_suffix('.json')
        if handoff_json.is_file():
            handoff_data = load(handoff_json)
            artifacts = handoff_data.get('artifacts') or {}
            media_path = inside(root, artifacts.get('media_path'))
            if media_path:
                candidates.append((media_path, artifacts.get('media_sha256'),
                                   'handoff.artifacts.media_path'))
    for field in ('final_directory', 'directory'):
        directory = inside(root, record.get(field))
        if directory:
            path = directory / 'clip.mp4'
            result_path = directory / 'result.json'
            expected = load(result_path).get('output_sha256') if result_path.is_file() else None
            candidates.append((path, expected, field + '/clip.mp4'))
    seen = set()
    for path, expected, basis in candidates:
        if path in seen:
            continue
        seen.add(path)
        if path.is_file():
            return path, expected, basis, handoff_data
    return None, None, None, handoff_data


def extract_lossless_audio(ffmpeg, source, expected_sha, target):
    """Extract all current-clip audio losslessly into the checkpoint only."""
    evidence = {'attempted': False, 'included': False,
                'source_path': str(source) if source else None,
                'source_expected_sha256': expected_sha}
    if source is None:
        evidence['omission_reason'] = 'No current clip exists inside the run root'
        return evidence
    source_sha = sha(source)
    evidence.update(source_sha256=source_sha, source_bytes=source.stat().st_size)
    if expected_sha and source_sha != expected_sha:
        evidence['omission_reason'] = 'Current clip differs from its hash-bound result/handoff'
        return evidence
    if not ffmpeg or not Path(ffmpeg).is_file():
        evidence['omission_reason'] = 'Configured ffmpeg executable is unavailable'
        return evidence
    target.parent.mkdir(parents=True, exist_ok=True)
    evidence['attempted'] = True
    extract = subprocess.run([str(ffmpeg), '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', str(source), '-map', '0:a:0', '-vn', '-c:a', 'flac', '-y', str(target)],
        capture_output=True, text=True, encoding='utf-8', timeout=1800)
    if extract.returncode or not target.is_file() or not target.stat().st_size:
        target.unlink(missing_ok=True)
        evidence['omission_reason'] = 'Lossless extraction failed: ' + (extract.stderr[-1000:] or 'no output')
        reject_text_secrets(evidence['omission_reason'].encode('utf-8'))
        return evidence
    decode = subprocess.run([str(ffmpeg), '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', str(target), '-f', 'null', os.devnull], capture_output=True, text=True,
        encoding='utf-8', timeout=1800)
    if decode.returncode:
        target.unlink(missing_ok=True)
        evidence['omission_reason'] = 'Lossless derivative failed full decode: ' + decode.stderr[-1000:]
        reject_text_secrets(evidence['omission_reason'].encode('utf-8'))
        return evidence
    evidence.update(included=True, bundle_path='audio/current.flac', audio_sha256=sha(target),
                    audio_bytes=target.stat().st_size, full_decode_passed=True,
                    codec='FLAC (lossless decoded-audio derivative)', complete_current_clip=True)
    return evidence


def related_hold_metadata(root, destination, vid, record):
    """Copy complete bounded metadata for one selected fallback."""
    root, destination = Path(root).resolve(), Path(destination)
    copied, directories = [], []

    def capture(source, relative):
        if source and source.is_file():
            copy_checked(source, destination / relative, root)
            copied.append(relative.as_posix())

    capture(root / 'input' / 'candidates' / f'{vid}.json', Path('input-candidate.json'))
    for folder in SELECTED_RECEIPT_DIRS:
        capture(root / folder / f'{vid}.json', Path(folder) / f'{vid}.json')
    handoff = inside(root, record.get('handoff'))
    if handoff:
        capture(handoff, Path('handoff') / handoff.name)
        capture(handoff.with_suffix('.json'), Path('handoff') / handoff.with_suffix('.json').name)
    media, expected, basis, _ = current_media(root, record)
    for value in (record.get('final_directory'), record.get('directory'),
                  str(media.parent) if media else None):
        directory = inside(root, value)
        if directory and directory.is_dir() and directory not in directories:
            directories.append(directory)
    for index, directory in enumerate(directories, 1):
        for source in sorted(directory.rglob('*')):
            if (not source.is_file() or source.suffix.lower() in MEDIA_SUFFIXES
                    or source.suffix.lower() not in METADATA_SUFFIXES
                    or source.name in UNSAFE_BATCH_FILES):
                continue
            relative = Path(f'artifact-{index:02d}') / source.relative_to(directory)
            capture(source, relative)
    return {'copied_metadata': copied, 'current_media_path': str(media) if media else None,
            'current_media_expected_sha256': expected, 'current_media_basis': basis,
            'metadata_directories': [str(path) for path in directories]}


def build(root, continuation, destination, ffmpeg=None, final=False):
    root, continuation, destination = map(lambda value: Path(value).resolve(),
                                           (root, continuation, destination))
    if not root.is_dir() or not continuation.is_dir() or destination.is_relative_to(root):
        raise ValueError('Run/continuation must exist and checkpoint must be outside the run root')
    destination.mkdir(parents=True, exist_ok=False)
    auth = load(continuation / 'authorization.json')
    plan = load(continuation / 'continuation-plan.json')
    preflight = load(continuation / 'preflight-reconciliation.json')
    ids_path = continuation / auth['selected_ids_file']
    raw_ids = ids_path.read_bytes()
    ids = raw_ids.decode('ascii').splitlines()
    selected = set(ids)
    if (auth.get('scope') != 'fixed_subset_frozen_manifest'
            or ids != plan.get('authorized_candidate_ids') or len(ids) != 340
            or len(selected) != 340 or sha(ids_path) != auth.get('selected_ids_sha256')
            or plan.get('continuation_id') != auth.get('job_id')):
        raise ValueError('Checkpoint selection differs from frozen fixed-subset authority')

    for name in CONTINUATION_FILES:
        source = continuation / name
        if source.is_file():
            copy_checked(source, destination / 'scope' / name, continuation)

    # Preserve only the exact retirement evidence named by authorization.
    handoff = auth.get('broad_owner_handoff', {})
    ownership = {'status.json': handoff.get('status_path'),
        'control-state.json': handoff.get('control_state_path'),
        'retirement-receipt.json': handoff.get('retirement_receipt_path'),
        'live-revoked-authorization.json': handoff.get('live_authorization_path'),
        'live-revoked-admission.json': handoff.get('live_admission_path')}
    for name, value in ownership.items():
        source = Path(value).resolve() if value else None
        if source and source.is_file():
            copy_checked(source, destination / 'ownership' / name)

    preflight_overlay = validate_preflight_hold_receipt(
        root, continuation, plan, required=False)
    partition, hashes, records = defaultdict(list), {}, {}
    for vid in ids:
        source = root / 'records' / f'{vid}.json'
        if source.exists():
            row = load(source)
            if row.get('candidate_id') != vid:
                raise ValueError('Selected record identity mismatch: ' + vid)
            source_status = row.get('status', 'unknown')
            status = preflight_overlay.get(vid, {}).get('effective_status', source_status)
            if vid in preflight_overlay:
                row = {**row, 'source_record_status': source_status, 'status': status,
                       'reason': preflight_overlay[vid]['reason'],
                       'packet_path': preflight_overlay[vid]['packet_path']}
            copy_checked(source, destination / 'selected-records' / source.name, root)
            hashes[vid], records[vid] = sha(source), row
        else:
            status, hashes[vid] = 'unadmitted', None
        partition[status].append(vid)

    for folder in SELECTED_RECEIPT_DIRS:
        for vid in ids:
            source = root / folder / f'{vid}.json'
            if source.is_file():
                copy_checked(source, destination / 'selected-evidence' / folder / source.name, root)

    response_inventory, batch_names = [], []
    for slot in plan.get('slots', []):
        name, members = slot.get('batch_name'), slot.get('candidate_ids', [])
        execution = slot.get('execution_candidate_ids', members)
        item_ids = [item.get('candidate_id') for item in slot.get('items', [])]
        frozen_members = set(members) | set(execution) | set(item_ids)
        if (not isinstance(name, str) or Path(name).name != name or name in batch_names
                or not members or None in frozen_members or not frozen_members.issubset(selected)
                or not set(execution).issubset(set(members)) or not set(item_ids).issubset(set(members))):
            raise ValueError('Unsafe or off-scope fixed-plan batch')
        batch_names.append(name)
        batch = root / 'batches' / name
        if not batch.is_dir():
            continue
        disk_plan_path = batch / 'batch-plan.json'
        if disk_plan_path.is_file():
            disk_plan = load(disk_plan_path)
            disk_members = set(disk_plan.get('slot_candidate_ids', [])) | set(disk_plan.get('candidate_ids', []))
            if not disk_members or not disk_members.issubset(selected) or disk_members != set(execution):
                raise ValueError('On-disk fixed batch membership differs from the frozen execution slot')
        for source in sorted(batch.rglob('*')):
            if (not source.is_file() or source.suffix.lower() not in METADATA_SUFFIXES
                    or source.suffix.lower() in MEDIA_SUFFIXES or source.name in UNSAFE_BATCH_FILES):
                continue
            relative = source.relative_to(batch)
            copy_checked(source, destination / 'fixed-plan-batches' / name / relative, root)
            if source.name == 'response.json':
                raw = load(source)
                response_inventory.append({'batch_name': name,
                    'path': 'fixed-plan-batches/' + name + '/' + relative.as_posix(),
                    'sha256': sha(source), 'response_id': raw.get('id'), 'model': raw.get('model'),
                    'status': raw.get('status'), 'usage': raw.get('usage')})

    state = delivery_state(continuation, auth, preflight, selected)
    fallback_ids = sorted(vid for vid, row in records.items()
                          if row.get('status') in FALLBACK_STATUSES)
    delivered = set(state['delivered_fallback_ids'])
    new_fallback_ids = [vid for vid in fallback_ids if vid not in delivered]
    hold_inventory = []
    for vid in fallback_ids:
        packet = destination / 'fallbacks' / vid
        packet.mkdir(parents=True, exist_ok=True)
        row = records[vid]
        copy_checked(root / 'records' / f'{vid}.json', packet / 'record.json', root)
        metadata = related_hold_metadata(root, packet / 'metadata', vid, row)
        audio = {'attempted': False, 'included': False,
            'omission_reason': 'Previously delivered fallback; metadata refreshed without media duplication'}
        if vid in new_fallback_ids:
            media = Path(metadata['current_media_path']) if metadata['current_media_path'] else None
            audio = extract_lossless_audio(ffmpeg, media, metadata['current_media_expected_sha256'],
                                           packet / 'audio' / 'current.flac')
        index = {'schema_version': 'snippy-fixed-subset-fallback-v1', 'candidate_id': vid,
            'status': row.get('status'), 'new_in_this_checkpoint': vid in new_fallback_ids,
            'metadata': metadata, 'audio': audio}
        reject_secrets(index)
        audit.atomic(packet / 'index.json', index)
        hold_inventory.append(index)

    snapshot = {'schema_version': 'snippy-fixed-subset-checkpoint-partition-v2',
        'generated_at': audit.now(), 'job_id': auth['job_id'], 'final': bool(final),
        'selected_ids_sha256': auth['selected_ids_sha256'], 'plan_sha256': plan['plan_sha256'],
        'counts': {key: len(value) for key, value in sorted(partition.items())},
        'partition': {key: value for key, value in sorted(partition.items())},
        'record_sha256': hashes, 'fallback_ids': fallback_ids,
        'baseline_delivery_evidence': state.get('baseline_delivery_evidence', []),
        'previously_delivered_fallback_ids': sorted(delivered),
        'new_fallback_ids_in_this_checkpoint': new_fallback_ids,
        'fixed_plan_batch_names': batch_names, 'fixed_plan_raw_responses': response_inventory,
        'scope_statement': 'Only the frozen 340 IDs and exact fixed-plan batch directories are included.'}
    audit.atomic(destination / 'partition.json', snapshot)
    audit.atomic(destination / 'fallback-inventory.json', {'items': hold_inventory})
    readme = ('# Fixed-subset checkpoint\n\nThis immutable bundle is bounded to the 340 IDs in '
        '`scope/selected-ids.txt`. It includes selected records/receipts/recipes, complete metadata '
        'for every current fallback, and raw responses/evidence only from batch directories frozen '
        'into the fixed plan. No broad-batch directory, request package, secret, or video byte is '
        'included. New fallback cases receive a full-current-clip lossless FLAC when a hash-bound '
        'current clip and ffmpeg are available.\n')
    (destination / 'README.md').write_text(readme, encoding='utf-8', newline='\n')
    reject_text_secrets((destination / 'README.md').read_bytes())

    entries = []
    for path in sorted(item for item in destination.rglob('*') if item.is_file()
                       and item.name != 'checkpoint-manifest.json'):
        if path.is_symlink() or not path.resolve().is_relative_to(destination):
            raise ValueError('Unsafe checkpoint destination path')
        entries.append({'path': path.relative_to(destination).as_posix(),
                        'size': path.stat().st_size, 'sha256': sha(path)})
    if len(entries) != len({row['path'].casefold() for row in entries}):
        raise ValueError('Duplicate checkpoint path')
    manifest = {'schema_version': 'snippy-fixed-subset-checkpoint-v2',
        'created_at': audit.now(), 'job_id': auth['job_id'], 'final': bool(final),
        'selected_ids_sha256': auth['selected_ids_sha256'], 'plan_sha256': plan['plan_sha256'],
        'files': entries, 'file_count': len(entries),
        'total_bytes': sum(row['size'] for row in entries)}
    manifest['manifest_sha256'] = audit.digest(manifest)
    audit.atomic(destination / 'checkpoint-manifest.json', manifest)
    for item in manifest['files']:
        if sha(destination / item['path']) != item['sha256']:
            raise ValueError('Checkpoint readback hash failed: ' + item['path'])
    return {'directory': str(destination), 'job_id': auth['job_id'], 'final': bool(final),
        'selected_ids_sha256': auth['selected_ids_sha256'], 'file_count': len(entries) + 1,
        'total_bytes': manifest['total_bytes'] + (destination / 'checkpoint-manifest.json').stat().st_size,
        'manifest_file_sha256': sha(destination / 'checkpoint-manifest.json'),
        'manifest_sha256': manifest['manifest_sha256'], 'counts': snapshot['counts'],
        'fallback_ids': fallback_ids, 'new_fallback_ids': new_fallback_ids,
        'recorded_candidates': sum(value is not None for value in hashes.values())}


def create_checkpoint(root, continuation, output, ffmpeg=None, final=False):
    root, continuation, output = Path(root).resolve(), Path(continuation).resolve(), Path(output).resolve()
    if output.is_relative_to(root):
        raise ValueError('Checkpoint output must be outside the production root')
    output.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    name = 'fixed-subset-' + stamp + '-' + uuid.uuid4().hex[:8]
    staging, final_path = output / ('.' + name + '.incomplete'), output / name
    try:
        result = build(root, continuation, staging, ffmpeg=ffmpeg, final=final)
        staging.rename(final_path)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    result['directory'] = str(final_path)
    result['manifest_file_sha256'] = sha(final_path / 'checkpoint-manifest.json')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--continuation', type=Path, required=True)
    parser.add_argument('--output', '--destination', dest='output', type=Path, required=True)
    parser.add_argument('--ffmpeg', type=Path)
    parser.add_argument('--final', action='store_true')
    args = parser.parse_args(argv)
    print(json.dumps(create_checkpoint(args.root, args.continuation, args.output,
                                       ffmpeg=args.ffmpeg, final=args.final), indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
