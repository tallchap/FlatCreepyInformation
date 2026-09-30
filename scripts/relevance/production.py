#!/usr/bin/env python3
"""Resumable production queue: staged excerpts → existing Luna gate → publication.

No new editorial model or weakened gate. Unresolved evidence is retained for Astra.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import math
import os
from pathlib import Path
import threading
from types import SimpleNamespace
import requests
import audit
from captions import parse_captions
import luna_batch_qa as luna
import process_astra as media
import publish_astra

TERMINAL = {'published', 'already_published', 'awaiting_astra', 'failed'}


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
            receipt = luna.read(Path(row['publication_receipt']))
            receipts_valid &= receipt.get('passed') is True and receipt['video_id'] == row['candidate_id']
            if row['status'] == 'published':
                directory = Path(row['final_directory'])
                qa = luna.read(directory / 'final-qa.json')
                media_valid &= (luna.sha(directory / 'clip.mp4') == receipt['media_sha256'] == qa['media_sha256']
                                and audit.digest(luna.read(directory / 'recipe.json')) == receipt['recipe_hash'] == qa['recipe_hash']
                                and qa.get('passed') is True)
        except (OSError, ValueError, KeyError):
            receipts_valid = False
    checks = {'exact_coverage': len(ids) == len(set(ids)) == len(wanted) and set(ids) == wanted,
              'all_disposed': all(r['status'] in TERMINAL for r in rows),
              'all_completed': len(rows) == len(wanted) and all(r['status'] in ('published', 'already_published') for r in rows),
              'publication_receipts': receipts_valid, 'published_media_and_qa_hashes': media_valid}
    report = {'requested': len(wanted), 'time': audit.now(), 'counts': dict(Counter(r['status'] for r in rows)),
              'checks': checks, 'passed': all(checks.values()), 'improver': 'Frozen calibrated prompts; Astra escalation evidence retained, no automatic prompt mutation'}
    audit.atomic(root / 'verification.json', report)
    return report


class Runner:
    def __init__(self, root, whisper, limit=None):
        self.root, self.whisper, self.limit = root.resolve(), whisper, limit
        self.input = self.root / 'input'
        self.manifest = luna.read(self.input / 'manifest.json')
        self.candidates = self.manifest['candidates']
        assert len(self.candidates) == len({r['candidate_id'] for r in self.candidates}) == 1644
        self.prior = luna.read(self.input / 'already-published.json')
        self.records = {p.stem: luna.read(p) for p in (self.root / 'records').glob('*.json')}
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.phase = 'starting'
        self.error = None
        self.responses = {}
        self.sources = {r['video_id']: r for r in audit.inputs(self.input / 'audit-run')}
        self.forbidden = {r['video_id'] for r in luna.read(self.input / 'culled-ids.json')}
        assert not (set(self.sources) & self.forbidden)
        self.active_ids = set()

    def save(self, vid, status, **values):
        with self.lock:
            row = {**self.records.get(vid, {}), 'candidate_id': vid, 'status': status, 'updated_at': audit.now(), **values}
            audit.atomic(self.root / 'records' / f'{vid}.json', row)
            self.records[vid] = row
        print(audit.now(), vid, status, flush=True)
        self.heartbeat()

    def heartbeat(self):
        with self.lock:
            # Raw responses include successful API calls even when normalization failed.
            for path in (self.root / 'batches').glob('*/*/response.json'):
                raw = luna.read(path)
                if raw.get('id'):
                    self.responses[raw['id']] = audit.price(raw)
            counts = Counter(r['status'] for r in self.records.values())
            done = sum(counts[s] for s in TERMINAL)
            audit.atomic(self.root / 'status.json', {'time': audit.now(), 'pid': os.getpid(), 'machine': 'Mac',
                'phase': self.phase, 'requested': 1644, 'covered': done, 'remaining': 1644 - done,
                'counts': dict(counts), 'active_ids': sorted(self.active_ids), 'luna_cost_usd': sum(self.responses.values()),
                'unique_api_responses': len(self.responses), 'error': self.error,
                'storage_provider': 'Google Cloud Storage', 'bucket': 'snippysaurus-clips'})
            audit.atomic(self.root / 'astra-handoff-queue.json', {'time': audit.now(),
                'items': [r for r in self.records.values() if r['status'] == 'awaiting_astra'],
                'operational_failures': [r for r in self.records.values() if r['status'] == 'failed']})

    def pulse(self):
        while not self.stop.wait(30):
            try:
                self.heartbeat()
            except Exception as exc:
                print('Heartbeat error:', str(exc), flush=True)

    def prepare(self, item):
        vid = item['candidate_id']
        try:
            with self.lock:
                self.active_ids.add(vid)
            self.save(vid, 'preparing')
            packet = luna.read(self.input / 'candidates' / f'{vid}.json')
            if audit.digest(packet) != item['packet_sha256']:
                raise ValueError('Input packet changed since manifest')
            try:
                recipe = seed(packet, self.sources[vid])
            except ValueError as exc:
                self.save(vid, 'awaiting_astra', stage='proposal', reason=str(exc),
                          packet_path=str(self.input / 'candidates' / f'{vid}.json'))
                return None
            valid = media.validate(recipe, packet, self.sources[vid], self.forbidden)
            audit.atomic(self.root / 'recipes' / f'{vid}.json', recipe)
            args = SimpleNamespace(output=self.root / 'rendered', max_transfer_bytes=256 * 1024**2)
            result = media.render(args, recipe, packet, valid)
            directory = Path(result['clip_path']).parent
            self.save(vid, 'transcribing', directory=str(directory), transfer=result['transfer'])
            luna.ensure_asr(directory, self.whisper)
            if not (directory / 'contact.jpg').exists():
                luna.contact_sheet(directory)
            self.save(vid, 'prepared', directory=str(directory))
            return directory
        except Exception as exc:
            self.save(vid, 'failed', stage='preparation', error=f'{type(exc).__name__}: {exc}')
            return None
        finally:
            with self.lock:
                self.active_ids.discard(vid)

    def run(self):
        thread = threading.Thread(target=self.pulse, daemon=True)
        thread.start()
        try:
            self.phase = 'verifying_previous_publications'
            for vid, receipt in self.prior.items():
                if self.records.get(vid, {}).get('status') in TERMINAL:
                    continue
                live_receipt(receipt)
                path = self.root / 'publications' / f'{vid}.json'
                audit.atomic(path, receipt)
                self.save(vid, 'already_published', publication_receipt=str(path))
            # Fail closed on any unexpected existing Astra record; never duplicate it.
            existing = {r['original_video_id'] for r in audit.bq_client().query(
                "SELECT DISTINCT original_video_id FROM `youtubetranscripts-429803.reptranscripts.snippets_auto` WHERE provider='astra'").result()}
            for vid in existing - set(self.prior):
                if vid in self.sources and self.records.get(vid, {}).get('status') not in TERMINAL:
                    self.save(vid, 'failed', stage='existing_publication', error='Untracked prior publication requires reconciliation')
            failures = 0
            batches = 0
            for lane in ('eligible', 'review'):
                items = [r for r in self.candidates if r['lane'] == lane]
                for i in range(0, len(items), 5):
                    group = [r for r in items[i:i+5] if self.records.get(r['candidate_id'], {}).get('status') not in TERMINAL]
                    if not group:
                        continue
                    if self.limit is not None and batches >= self.limit:
                        return
                    self.phase = f'preparing_{lane}_{i//5+1}'
                    self.heartbeat()
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        directories = [d for d in pool.map(self.prepare, group) if d]
                    batches += 1
                    if not directories:
                        failures += 1
                        if failures >= 3:
                            raise RuntimeError('Three consecutive empty/failed batches; inspect source/render errors before resume')
                        continue
                    batch = self.root / 'batches' / f'{lane}-{i//5+1:04d}'
                    self.phase = 'luna_' + batch.name
                    for d in directories:
                        self.save(luna.read(d / 'recipe.json')['candidate_id'], 'reviewing')
                    try:
                        result = luna.pipeline(SimpleNamespace(clips=directories, packets=self.input / 'candidates',
                            output=batch, run_id='production-1644-v1-' + batch.name, images=[],
                            min_release_confidence=.95, whisper_cli=self.whisper))
                        for decision in result['decisions']:
                            vid = decision['candidate_id']
                            if decision['status'] != 'pass' or not decision['complete']:
                                self.save(vid, 'awaiting_astra', handoff=decision['astra_escalation_path'], reason=decision.get('reason'))
                                continue
                            recipe, clip = Path(decision['recipe_path']), Path(decision['media_path'])
                            self.save(vid, 'publishing')
                            receipt_path = self.root / 'publications' / f'{vid}.json'
                            try:
                                publish_astra.publish(recipe, clip, recipe.parent / 'final-qa.json', receipt_path)
                                live_receipt(luna.read(receipt_path))
                                self.save(vid, 'published', publication_receipt=str(receipt_path), final_directory=str(recipe.parent))
                            except Exception as exc:
                                self.save(vid, 'failed', stage='publication', error=f'{type(exc).__name__}: {exc}', retry_recipe=str(recipe), retry_media=str(clip))
                        failures = 0
                    except Exception as exc:
                        for d in directories:
                            vid = luna.read(d / 'recipe.json')['candidate_id']
                            if self.records[vid]['status'] not in TERMINAL:
                                self.save(vid, 'failed', stage='luna', error=f'{type(exc).__name__}: {exc}', batch=str(batch))
                        failures += 1
                        if failures >= 3:
                            raise RuntimeError('Three consecutive Luna batches failed; refusing repeated unproductive calls') from exc
            self.phase = 'coverage_finished'
            verify(self.root)
        except Exception as exc:
            self.phase, self.error = 'stopped_on_error', f'{type(exc).__name__}: {exc}'
            raise
        finally:
            self.stop.set()
            self.heartbeat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('.context/astra-clips/production-1644'))
    parser.add_argument('--whisper-cli', default='/opt/homebrew/bin/whisper')
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--max-batches', type=int)
    args = parser.parse_args()
    if args.verify:
        result = verify(args.root)
        print(json.dumps(result, indent=2))
        raise SystemExit(0 if result['passed'] else 1)
    args.root.mkdir(parents=True, exist_ok=True)
    with (args.root / 'runner.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        Runner(args.root, args.whisper_cli, args.max_batches).run()


if __name__ == '__main__':
    main()
