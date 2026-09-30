#!/usr/bin/env python3
"""Archive a completed first wave and admit one disjoint, bounded second wave.

Offline only. Acquires supervisor.lock then runner.lock. Never starts a runner,
uploads, retries a request, or removes ledger, receipts, batches, or media.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import uuid

import audit
import production

JOB_ID = 'SNIPPY-LUNA-CODEX-1644-20260930'
RECEIPT_SCOPE = 'Relay committed upload receipt; consumer acknowledgment not implied'
RESET_FILES = {
    'experiment-status.json', 'supervisor.json', 'benchmark-report.json', 'benchmark-report.md',
    'failure-analysis.json', 'failure-analysis.md', 'preparation-timing.json', 'preparation-timing.md',
}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inside(root, path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('Evidence path must stay inside the run root')
    path = path.resolve()
    if not path.is_relative_to(root):
        raise ValueError('Evidence path must stay inside the run root')
    return path


def validate_plan(plan, manifest):
    unsigned = {key: value for key, value in plan.items() if key != 'plan_sha256'}
    ids = [vid for slot in plan['slots'] for vid in slot['candidate_ids']]
    items = {row['candidate_id']: row for row in manifest['candidates']}
    if (plan.get('plan_sha256') != audit.digest(unsigned) or len(plan['slots']) != 10
            or any(len(slot['candidate_ids']) != 5 for slot in plan['slots'])
            or len(ids) != len(set(ids)) or len(ids) != 50 or ids != plan['candidate_ids']
            or any(slot['items'] != [items[vid] for vid in slot['candidate_ids']] for slot in plan['slots'])):
        raise ValueError('Frozen experiment plan hash or membership is invalid')


def validate_receipt(path, experiment_id):
    receipt = read(path)
    if (receipt.get('experiment_id') != experiment_id or receipt.get('job_id') != JOB_ID
            or receipt.get('verified') is not True or not receipt.get('asset_id')
            or not receipt.get('sent_at') or receipt.get('verification_scope') != RECEIPT_SCOPE
            or any(not re.fullmatch('[0-9a-fA-F]{64}', receipt.get(key, '')) for key in ('bundle_sha256', 'manifest_sha256'))):
        raise ValueError('A matching committed Relay checkpoint upload receipt is required; acknowledgment is not required')
    return receipt


def validate_first_wave(root, first, manifest, preserve_unknown):
    validate_plan(first, manifest)
    if first.get('wave_number', 1) != 1 or first.get('previous_experiment_id'):
        raise ValueError('Only the first-to-second wave transition is authorized; maximum two waves / 100 fresh candidates')
    if first['manifest_sha256'] != sha(root / 'input/manifest.json'):
        raise ValueError('Immutable input manifest changed')
    status, report = read(root / 'experiment-status.json'), read(root / 'benchmark-report.json')
    if (status.get('experiment_id') != first['experiment_id'] or status.get('phase') != 'experiment_completed'
            or not status.get('finished_at') or report.get('experiment_id') != first['experiment_id']):
        raise ValueError('First wave must be completed and have its final benchmark report')
    if report.get('authorized', {}).get('frozen_ids') != first['candidate_ids']:
        raise ValueError('First-wave benchmark report membership differs from its plan')
    for check in ('integrity', 'exact_fifty_coverage', 'all_fifty_disposed', 'no_overrun', 'experiment_finished'):
        if report.get('checks', {}).get(check) is not True:
            raise ValueError('First-wave report check failed: ' + check)
    unknown = report.get('transport', {}).get('unknown_or_unmatched', [])
    if unknown and not preserve_unknown:
        raise ValueError('First wave has unknown charges; use --preserve-unknown-charges to preserve them without any retry')
    records = {path.stem: read(path) for path in (root / 'records').glob('*.json')}
    expected = set(first['candidate_ids']) | set(first.get('baseline_record_sha256', {}))
    if set(records) != expected:
        raise ValueError('Ledger has missing or out-of-experiment candidate IDs')
    for vid, digest in first.get('baseline_record_sha256', {}).items():
        if sha(root / 'records' / f'{vid}.json') != digest:
            raise ValueError('Prior baseline record changed: ' + vid)
    allowed_batches = {slot['batch_name'] for slot in first['slots']}
    baseline_response_ids = set(first.get('baseline_response_ids', []))
    for path in (root / 'batches').glob('*/*/request.json'):
        if path.parent.parent.name in allowed_batches:
            continue
        response_path = path.parent / 'response.json'
        if not response_path.exists() or read(response_path).get('id') not in baseline_response_ids:
            raise ValueError('Unreported request outside first wave and its frozen baseline: ' + path.relative_to(root).as_posix())
    packet_hashes = {row['candidate_id']: row['packet_sha256'] for row in manifest['candidates']}
    for vid in first['candidate_ids']:
        row = records[vid]
        if row.get('candidate_id') != vid or row.get('status') not in production.TERMINAL:
            raise ValueError('First-wave candidate is not terminal: ' + vid)
        if audit.digest(read(root / 'input/candidates' / f'{vid}.json')) != packet_hashes[vid]:
            raise ValueError('Candidate packet changed: ' + vid)
        if row['status'] in ('published', 'already_published'):
            receipt = read(inside(root, production.artifact_path(root, row['publication_receipt'])))
            if receipt.get('passed') is not True or receipt.get('video_id') != vid:
                raise ValueError('Publication receipt is invalid: ' + vid)
            directory = inside(root, production.artifact_path(root, row['final_directory']))
            qa = read(directory / 'final-qa.json')
            if (qa.get('passed') is not True or sha(directory / 'clip.mp4') != qa.get('media_sha256')
                    or qa.get('media_sha256') != receipt.get('media_sha256')
                    or audit.digest(read(directory / 'recipe.json')) != qa.get('recipe_hash')
                    or qa.get('recipe_hash') != receipt.get('recipe_hash')
                    or not production.luna.release_gate_passed(qa.get('release_gate'), .95)):
                raise ValueError('Publication media, recipe, or independent QA hash/gate failed: ' + vid)
        elif row['status'] == 'awaiting_astra':
            if row.get('handoff'):
                handoff = inside(root, production.artifact_path(root, row['handoff']))
                if not handoff.exists() or not handoff.with_suffix('.json').exists():
                    raise ValueError('Astra handoff evidence missing: ' + vid)
                held = read(handoff.with_suffix('.json'))
                if held.get('candidate_id') != vid or held.get('status') != 'awaiting_astra' or not held.get('reason'):
                    raise ValueError('Astra handoff identity or reason is invalid: ' + vid)
                evidence = held['artifacts']
                media = inside(root, production.artifact_path(root, evidence['media_path']))
                recipe = inside(root, production.artifact_path(root, evidence['recipe_path']))
                asr = inside(root, production.artifact_path(root, evidence['asr_path']))
                if (sha(media) != evidence['media_sha256'] or audit.digest(read(recipe)) != evidence['recipe_hash']
                        or sha(asr) != evidence['asr_sha256']):
                    raise ValueError('Astra evidence hash drift: ' + vid)
            elif row.get('stage') != 'proposal' or not row.get('packet_path') or not row.get('reason'):
                raise ValueError('Astra hold lacks handoff or proposal evidence: ' + vid)
        elif not row.get('stage') or not (row.get('error') or row.get('reason')):
            raise ValueError('Operational failure is unnamed: ' + vid)
    return records, unknown


def next_plan(root, first, manifest, records, next_id, receipt_path):
    selected, slots = [], []
    for lane, count in (('eligible', 35), ('review', 15)):
        fresh = [row for row in manifest['candidates'] if row['lane'] == lane and row['candidate_id'] not in records][:count]
        if len(fresh) != count:
            raise ValueError(f'Need {count} fresh {lane} candidates; no replacement lane is authorized')
        selected.extend(fresh)
        for i in range(0, count, 5):
            items = fresh[i:i+5]
            slots.append({'batch_name': f'{next_id}-{lane}-{i//5+1:04d}', 'lane': lane,
                          'candidate_ids': [row['candidate_id'] for row in items], 'items': items})
    if any((root / 'batches' / slot['batch_name']).exists() for slot in slots):
        raise ValueError('Second-wave batch namespace already contains artifacts; refusing reuse')
    responses, mac_ids = {}, set()
    for base in (root / 'batches', root / 'mac-checkpoint/batches'):
        for path in base.glob('*/*/response.json'):
            raw = read(path)
            if raw.get('id'):
                digest = audit.digest(raw)
                if raw['id'] in responses and responses[raw['id']]['digest'] != digest:
                    raise ValueError('Conflicting response identity in baseline')
                responses[raw['id']] = {'digest': digest, 'cost': audit.price(raw)}
                if base == root / 'mac-checkpoint/batches':
                    mac_ids.add(raw['id'])
    mac_cost = sum(responses[rid]['cost'] for rid in mac_ids)
    cost = sum(row['cost'] for row in responses.values())
    report = read(root / 'benchmark-report.json')
    previous_cost = report['api']['usage_derived_cost_usd']
    if abs(cost - first['baseline_luna_cost_usd'] - previous_cost) > 1e-9:
        raise ValueError('Saved response costs differ from first-wave baseline plus final report')
    request_paths = sorted(path.relative_to(root).as_posix() for path in (root / 'batches').glob('*/*/request.json'))
    ids = [row['candidate_id'] for row in selected]
    cumulative = first['candidate_ids'] + ids
    if len(cumulative) != len(set(cumulative)) or len(cumulative) != 100:
        raise ValueError('Second wave overlaps first wave or exceeds the 100-candidate authorization')
    plan = {'schema_version': 'snippy-bounded-experiment-v1', 'experiment_id': next_id, 'created_at': audit.now(),
            'wave_number': 2, 'maximum_wave_count': 2, 'maximum_fresh_candidates': 100,
            'previous_experiment_id': first['experiment_id'], 'previous_plan_sha256': first['plan_sha256'],
            'cumulative_candidate_ids': cumulative, 'target_batch_count': 10, 'target_candidate_count': 50,
            'candidate_ids': ids, 'slots': slots, 'manifest_sha256': first['manifest_sha256'],
            'baseline_covered_ids': sorted(vid for vid, row in records.items() if row['status'] in production.TERMINAL),
            'baseline_counts': dict(Counter(row['status'] for row in records.values())),
            'baseline_record_sha256': {vid: sha(root / 'records' / f'{vid}.json') for vid in records},
            'baseline_response_ids': sorted(responses), 'baseline_mac_cost_usd': mac_cost,
            'baseline_shadow_cost_usd': cost - mac_cost, 'baseline_luna_cost_usd': cost,
            'initial_shadow_cost_usd': first['baseline_shadow_cost_usd'],
            'previous_experiment_cost_usd': previous_cost,
            'baseline_request_paths': request_paths,
            'baseline_request_sha256': {relative: sha(root / relative) for relative in request_paths},
            'preserved_unknown_charge_count': len(report.get('transport', {}).get('unknown_or_unmatched', [])),
            'preserved_first_wave_unknown_charges': report.get('transport', {}).get('unknown_or_unmatched', []),
            'first_wave_checkpoint_receipt_sha256': sha(receipt_path)}
    plan['plan_sha256'] = audit.digest(plan)
    return plan


def archive_sources(root, first):
    sources = {root / 'input/manifest.json'}
    for path in root.iterdir():
        if path.is_file() and (path.suffix in ('.json', '.jsonl', '.md', '.csv') or path.name.startswith('production-attempt-') and path.suffix == '.log'):
            if path.name not in ('experiment-transition.json',):
                sources.add(path)
    for directory in ('records', 'publications', 'recipes'):
        sources.update((root / directory).glob('*.json'))
    sources.update(root / 'input/candidates' / f'{vid}.json' for vid in first['candidate_ids'])
    for slot in first['slots']:
        for path in (root / 'batches' / slot['batch_name']).rglob('*'):
            if path.is_file() and path.suffix in ('.json', '.jsonl', '.md') and path.name not in ('request.json', 'packages.json'):
                sources.add(path)
    for vid in first['candidate_ids']:
        record = read(root / 'records' / f'{vid}.json')
        directories = {production.artifact_path(root, record[key]) for key in ('directory', 'final_directory') if record.get(key)}
        # Preparation failures can occur before the runner saves directory.
        # The renderer already wrote its recipe and transfer/error evidence.
        for directory in (root / 'rendered').glob(vid + '-*'):
            recipe = directory / 'recipe.json'
            if recipe.exists():
                if read(recipe).get('candidate_id') != vid:
                    raise ValueError('Rendered evidence candidate identity differs: ' + str(directory))
                directories.add(directory)
        if record.get('handoff'):
            held = read(production.artifact_path(root, record['handoff']).with_suffix('.json'))
            directories.add(production.artifact_path(root, held['artifacts']['media_path']).parent)
        for directory in directories:
            for path in inside(root, directory).rglob('*'):
                if path.is_file() and path.suffix in ('.json', '.jsonl', '.md', '.jpg', '.png', '.log'):
                    sources.add(path)
    return sorted(sources)


def verify_archive(archive, expected_sha):
    manifest_path = archive / 'archive-manifest.json'
    if sha(manifest_path) != expected_sha:
        raise ValueError('Archive manifest changed')
    manifest = read(manifest_path)
    for item in manifest['files']:
        path = inside(archive.resolve(), archive / item['path'])
        if path.stat().st_size != item['size'] or sha(path) != item['sha256']:
            raise ValueError('Immutable archive artifact changed: ' + item['path'])
    return manifest


def finish_transition(root, journal, hook):
    archive = inside(root, root / journal['archive_relative'])
    staging = inside(root, root / journal['staging_relative'])
    if not archive.exists():
        verify_archive(staging, journal['archive_manifest_sha256'])
        staging.rename(archive)
    manifest = verify_archive(archive, journal['archive_manifest_sha256'])
    journal['stage'] = 'archived'
    audit.atomic(root / 'experiment-transition.json', journal)
    hook('archive_finalized')
    # Never alter original ledger/batch evidence when recovering a partial switch.
    for item in manifest['files']:
        relative = item.get('source_relative')
        if relative and Path(relative).parts[0] in ('records', 'publications', 'recipes', 'batches', 'input', 'rendered'):
            if sha(inside(root, root / relative)) != item['sha256']:
                raise ValueError('Preserved first-wave source changed during transition: ' + relative)
    for relative, digest in manifest.get('retained_request_sha256', {}).items():
        if sha(inside(root, root / relative)) != digest:
            raise ValueError('Preserved request changed during transition: ' + relative)
    current = read(root / 'experiment-plan.json')
    if (current.get('plan_sha256') not in (journal['first_plan_sha256'], journal['next_plan_sha256'])
            or current.get('plan_sha256') != audit.digest({k: v for k, v in current.items() if k != 'plan_sha256'})):
        raise ValueError('Canonical experiment plan changed outside this transition')
    archived_files = {item.get('source_relative'): item for item in manifest['files']}
    for name in sorted(RESET_FILES):
        path = root / name
        if path.exists():
            expected = archived_files.get(name)
            if not expected or sha(path) != expected['sha256']:
                raise ValueError('Canonical metadata changed while advancing: ' + name)
            path.unlink()  # Exact archived metadata only; never media or directories.
    hook('metadata_reset')
    plan = read(archive / 'next-experiment-plan.json')
    if plan['plan_sha256'] != journal['next_plan_sha256']:
        raise ValueError('Next frozen plan changed')
    # The plan replacement is the admission commit point. Mark the prepared
    # transaction complete first, so a newly visible plan never needs cleanup.
    # If interrupted here with the old plan intact, replay finishes the switch.
    journal.update(stage='complete', completed_at=audit.now())
    audit.atomic(root / 'experiment-transition.json', journal)
    hook('journal_committed')
    audit.atomic(root / 'experiment-plan.json', plan)
    hook('plan_installed')
    return journal


def advance_experiment(root, first_id, next_id, checkpoint_receipt, preserve_unknown_charges=False, _after_step=None):
    root = Path(root).resolve()
    checkpoint_receipt = Path(checkpoint_receipt).resolve()
    hook = _after_step or (lambda step: None)
    if not root.is_dir() or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', value) for value in (first_id, next_id)) or first_id == next_id:
        raise ValueError('Existing run root and distinct safe experiment IDs are required')
    with production.runner_lock(root / 'supervisor.lock'):
        with production.runner_lock(root / 'runner.lock'):
            journal_path = root / 'experiment-transition.json'
            if journal_path.exists():
                journal = read(journal_path)
                if journal['first_experiment_id'] != first_id or journal['next_experiment_id'] != next_id:
                    raise ValueError('A different transition already exists; maximum two waves / 100 fresh candidates')
                if sha(checkpoint_receipt) != journal['checkpoint_receipt_sha256']:
                    raise ValueError('Checkpoint receipt differs from the durable transition')
                if journal['stage'] == 'complete':
                    verify_archive(root / journal['archive_relative'], journal['archive_manifest_sha256'])
                    canonical = read(root / 'experiment-plan.json')
                    if canonical.get('plan_sha256') == journal['next_plan_sha256']:
                        if canonical['plan_sha256'] != audit.digest({k: v for k, v in canonical.items() if k != 'plan_sha256'}):
                            raise ValueError('Completed transition canonical plan changed')
                        return journal
                    if canonical.get('plan_sha256') != journal['first_plan_sha256']:
                        raise ValueError('Completed transition canonical plan changed')
                return finish_transition(root, journal, hook)
            first = read(root / 'experiment-plan.json')
            if first.get('experiment_id') != first_id:
                raise ValueError('First experiment ID does not match the canonical plan')
            validate_receipt(checkpoint_receipt, first_id)
            manifest = read(root / 'input/manifest.json')
            records, unknown = validate_first_wave(root, first, manifest, preserve_unknown_charges)
            following = next_plan(root, first, manifest, records, next_id, checkpoint_receipt)
            archive = root / 'experiments' / first_id
            if archive.exists():
                raise ValueError('Archive exists without a transition journal; refusing overwrite')
            staging = archive.parent / ('.' + first_id + '.staging-' + uuid.uuid4().hex[:8])
            staging.mkdir(parents=True)
            files = []

            def copy(source, relative, source_relative=None):
                data = source.read_bytes()
                target = staging / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                files.append({'path': relative, 'source_relative': source_relative, 'size': len(data),
                              'sha256': hashlib.sha256(data).hexdigest()})

            for source in archive_sources(root, first):
                source = inside(root, source)
                relative = source.relative_to(root).as_posix()
                copy(source, 'artifacts/' + relative, relative)
            copy(checkpoint_receipt, 'checkpoint-upload-receipt.json')
            audit.atomic(staging / 'next-experiment-plan.json', following)
            files.append({'path': 'next-experiment-plan.json', 'source_relative': None,
                          'size': (staging / 'next-experiment-plan.json').stat().st_size,
                          'sha256': sha(staging / 'next-experiment-plan.json')})
            audit.atomic(staging / 'archive-manifest.json', {'schema_version': 'snippy-wave-archive-v1',
                'experiment_id': first_id, 'created_at': audit.now(), 'files': files,
                'first_wave_unknown_charge_evidence_preserved': unknown,
                'retained_request_sha256': following['baseline_request_sha256'],
                'media_policy': 'Original media and all request/batch files remain untouched in run; no media is copied or removed.'})
            journal = {'schema_version': 'snippy-second-wave-transition-v1', 'stage': 'prepared', 'created_at': audit.now(),
                'first_experiment_id': first_id, 'next_experiment_id': next_id,
                'first_plan_sha256': first['plan_sha256'], 'next_plan_sha256': following['plan_sha256'],
                'archive_relative': archive.relative_to(root).as_posix(), 'staging_relative': staging.relative_to(root).as_posix(),
                'archive_manifest_sha256': sha(staging / 'archive-manifest.json'),
                'checkpoint_receipt_sha256': sha(checkpoint_receipt), 'wave_number': 2,
                'maximum_wave_count': 2, 'maximum_fresh_candidates': 100,
                'preserved_unknown_charge_count': len(unknown)}
            audit.atomic(journal_path, journal)
            hook('journal_prepared')
            return finish_transition(root, journal, hook)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--from-experiment', required=True)
    parser.add_argument('--to-experiment', required=True)
    parser.add_argument('--checkpoint-receipt', type=Path, required=True)
    parser.add_argument('--preserve-unknown-charges', action='store_true')
    args = parser.parse_args()
    result = advance_experiment(args.root, args.from_experiment, args.to_experiment, args.checkpoint_receipt, args.preserve_unknown_charges)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
