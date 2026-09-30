#!/usr/bin/env python3
"""Import verified Relay inputs and an immutable Mac checkpoint without replay."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import audit


def digest_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def bootstrap(inputs, root):
    root.mkdir(parents=True, exist_ok=True)
    marker = root / 'checkpoint-import.json'
    if marker.exists():
        return json.loads(marker.read_text(encoding='utf-8'))
    checkpoint = inputs / 'mac-checkpoint'
    records = [json.loads(p.read_text(encoding='utf-8')) for p in (checkpoint / 'records').glob('*.json')]
    assert len(records) == len({r['candidate_id'] for r in records}) == 20
    held = [r for r in records if r['status'] == 'awaiting_astra']
    assert len(held) == 1 and held[0]['candidate_id'] == '-MkGsHg_EHE'
    assert sum(r['status'] in ('published', 'already_published') for r in records) == 19
    assert not (root / 'records').exists(), 'Refusing to overwrite an existing ledger'
    shutil.copytree(inputs / 'input', root / 'input', dirs_exist_ok=True)
    shutil.copytree(checkpoint, root / 'mac-checkpoint', dirs_exist_ok=True)
    shutil.copy2(checkpoint / 'status.json', root / 'checkpoint-status.json')
    prior = {}
    historical_prefix = '/Users/orinagel2/conductor/workspaces/flatcreepyinformation-v1/chicago/.context/astra-clips/production-1644'
    def remap(value):
        if isinstance(value, str) and value.startswith(historical_prefix + '/'):
            candidate = root / 'mac-checkpoint' / value[len(historical_prefix) + 1:]
            # No fabricated Windows locations for footage that was not transferred.
            return str(candidate.resolve()) if candidate.exists() else value
        return value
    for record in records:
        vid = record['candidate_id']
        source_path = checkpoint / 'records' / (vid + '.json')
        row = {**record, 'original_status': record['status'], 'checkpoint_origin': 'Mac',
               'checkpoint_record_sha256': digest_file(source_path),
               'checkpoint_record_path': str((root / 'mac-checkpoint/records' / (vid + '.json')).resolve())}
        for key in ('handoff', 'directory', 'final_directory'):
            if key in row:
                row['historical_' + key] = row[key]
                row[key] = remap(row[key])
        if row['status'] in ('published', 'already_published'):
            receipt = checkpoint / 'publications' / (vid + '.json')
            assert receipt.exists(), f'Missing previous receipt for {vid}'
            target = root / 'publications' / receipt.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(receipt, target)
            prior[vid] = json.loads(receipt.read_text(encoding='utf-8'))
            row.update(status='already_published', publication_receipt=str(target.resolve()),
                       checkpoint_receipt_sha256=digest_file(receipt), prior_verification_required=True)
        else:
            row['reserved_for'] = 'Astra on Mac; do not process on Shadow'
        audit.atomic(root / 'records' / (vid + '.json'), row)
    audit.atomic(root / 'input/already-published.json', prior)
    audit.atomic(root / 'checkpoint-paths.json', {historical_prefix: str((root / 'mac-checkpoint').resolve())})
    result = {'time': audit.now(), 'records': 20, 'already_published': 19,
              'reserved_awaiting_astra': ['-MkGsHg_EHE'], 'remaining': 1624,
              'original_checkpoint': str(checkpoint.resolve()),
              'original_manifest_sha256': digest_file(inputs / 'input/manifest.json'),
              'mac_cost_usd': 0.011997545, 'mac_response_count': 4,
              'status': 'imported_pending_external_verification'}
    audit.atomic(marker, result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(bootstrap(args.inputs, args.root), indent=2))
