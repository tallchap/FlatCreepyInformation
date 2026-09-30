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
from pathlib import Path
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
                 stream_id=None, max_candidates=None):
        if batch_workers not in range(1, 11):
            raise ValueError('Batch workers must be between 1 and 10')
        if batch_workers > 2 and not experiment_id:
            raise ValueError('More than two workers requires a frozen bounded experiment')
        if experiment_id and (batch_workers != 10 or limit != 10):
            raise ValueError('The bounded experiment requires exactly 10 workers and max-batches 10')
        if stream_id and (experiment_id or batch_workers > 2 or max_candidates not in range(1, 6)):
            raise ValueError('Streaming requires a unique stream-id, 1-5 max-candidates, and at most two batch workers')
        if max_candidates is not None and not stream_id:
            raise ValueError('max-candidates requires a frozen stream-id')
        self.root, self.whisper, self.limit = root.resolve(), whisper, limit
        frozen_path = self.root / 'experiment-plan.json'
        if experiment_id and (self.root / 'experiment-status.json').exists():
            previous = luna.read(self.root / 'experiment-status.json')
            if (previous.get('experiment_id') == experiment_id and previous.get('phase') in ('paused', 'cancelled')
                    and previous.get('drained_at')):
                raise ValueError('Drained paused/cancelled experiment cannot restart; its frozen scope remains closed')
        if frozen_path.exists() and (not experiment_id or luna.read(frozen_path).get('experiment_id') != experiment_id):
            status_path = self.root / 'experiment-status.json'
            previous = luna.read(status_path) if status_path.exists() else {}
            if (not stream_id or previous.get('phase') not in ('paused', 'cancelled') or not previous.get('drained_at')
                    or previous.get('experiment_id') != luna.read(frozen_path).get('experiment_id')):
                raise ValueError('Existing bounded experiment requires its matching experiment-id; queue continuation is paused')
        self.batch_workers = batch_workers
        self.experiment_id = experiment_id
        self.stream_id, self.max_candidates = stream_id, max_candidates
        self.review_barrier = None
        self.publication_lock = threading.Lock()
        self.render_slots = luna.RENDER_LOCK
        self.machine = machine or ('Shadow' if os.name == 'nt' else 'Mac')
        self.namespace = batch_namespace(self.root, namespace)
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
        checkpoint_status = self.root / 'checkpoint-status.json'
        self.checkpoint_status = luna.read(checkpoint_status) if checkpoint_status.exists() else {}
        self.sources = {r['video_id']: r for r in audit.inputs(self.input / 'audit-run')}
        self.forbidden = {r['video_id'] for r in luna.read(self.input / 'culled-ids.json')}
        assert not (set(self.sources) & self.forbidden)
        self.active_ids = set()
        self.active_batches = {}
        self.batch_claims = set()
        self.last_id = None

    def pause_candidates(self, items, stage):
        for item in items:
            vid = item['candidate_id']
            row = self.records.get(vid)
            if row and row.get('status') not in TERMINAL and row.get('status') != 'paused':
                self.save(vid, 'paused', previous_status=row.get('status'), pause_stage=stage,
                          pause_reason='Operator STOP.json; no new operations admitted', paused_at=audit.now())

    def stop_requested(self):
        try:
            luna.check_stop(self.root)
            return False
        except luna.OperationalPause:
            return True

    def save(self, vid, status, **values):
        with self.lock:
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
            counts = Counter(r['status'] for r in self.records.values())
            done = sum(counts[s] for s in TERMINAL)
            current_cost = sum(self.responses.values())
            checkpoint_cost = self.checkpoint_status.get('luna_cost_usd', 0)
            shadow_rows = [row for row in self.records.values() if row.get('checkpoint_origin') != 'Mac']
            source_failures = [row for row in shadow_rows if row['status'] == 'failed' and
                               any(term in str(row.get('error', '')).lower() for term in
                                   ('source generation', 'source not', '403', '404', '410', '412', 'gcs did not honor'))]
            transferred = sum(row.get('transfer', {}).get('upstream_body_bytes_read', 0) for row in shadow_rows)
            requested_bytes = sum(row.get('transfer', {}).get('upstream_requested_bytes', 0) for row in shadow_rows)
            audit.atomic(self.root / 'status.json', {'time': audit.now(), 'pid': os.getpid(), 'machine': self.machine,
                'batch_namespace': self.namespace, 'batch_workers': self.batch_workers,
                'active_batches': [dict(self.active_batches[name]) for name in sorted(self.active_batches)],
                'phase': self.phase, 'requested': 1644, 'covered': done, 'remaining': 1644 - done,
                'counts': dict(counts), 'active_ids': sorted(self.active_ids), 'luna_cost_usd': checkpoint_cost + current_cost,
                'checkpoint_luna_cost_usd': checkpoint_cost, 'current_luna_cost_usd': current_cost,
                'unique_api_responses': self.checkpoint_status.get('unique_api_responses', 0) + len(self.responses),
                'current_unique_api_responses': len(self.responses), 'error': self.error,
                'last_id': self.last_id, 'covered_ids': sorted(row['candidate_id'] for row in self.records.values() if row['status'] in TERMINAL),
                'already_published': counts['already_published'], 'newly_published': counts['published'],
                'awaiting_astra': counts['awaiting_astra'], 'source_failed': len(source_failures),
                'other_failed': counts['failed'] - len(source_failures),
                'gcs_body_bytes_read': transferred, 'gcs_requested_bytes_upper_bound': requested_bytes,
                'initial_render_output_bytes': sum(row.get('output_bytes', 0) for row in shadow_rows),
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
            luna.check_stop(self.root)
            with self.lock:
                self.active_ids.add(vid)
            if shutil.disk_usage(self.root).free < 10 * 1024**3:
                self.save(vid, 'failed', stage='disk_space_low', error='disk_space_low: less than 10 GiB free; no render attempted')
                return None
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
            with self.render_slots:
                luna.check_stop(self.root)
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
        except Exception as exc:
            self.save(vid, 'failed', stage='preparation', error=f'{type(exc).__name__}: {exc}')
            return None
        finally:
            with self.lock:
                self.active_ids.discard(vid)

    def batch_slots(self):
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
            group = [row for row in slot if self.records.get(row['candidate_id'], {}).get('status') not in TERMINAL]
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
            plan = bound_batch_plan(batch, [row['candidate_id'] for row in slot], directories, self.input / 'candidates')
            if any(row['candidate_id'] not in plan['candidate_ids'] and self.records.get(row['candidate_id'], {}).get('status') not in TERMINAL for row in group):
                raise ValueError('Nonterminal candidate was not part of frozen paid batch; explicit reconciliation required')
            for vid in plan['candidate_ids']:
                if self.records.get(vid, {}).get('status') not in TERMINAL:
                    self.save(vid, 'reviewing')
            result = planned_pipeline(plan, batch, self.input / 'candidates', self.whisper)
            self.batch_phase(batch, 'publishing')
            for decision in result['decisions']:
                luna.check_stop(self.root)
                vid = decision['candidate_id']
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
                        luna.check_stop(self.root)
                        publish_astra.publish(recipe, clip, recipe.parent / 'final-qa.json', receipt_path)
                        live_receipt(luna.read(receipt_path))
                        self.save(vid, 'published', publication_receipt=str(receipt_path), final_directory=str(recipe.parent))
                except luna.OperationalPause:
                    raise
                except Exception as exc:
                    self.save(vid, 'failed', stage='publication', error=f'{type(exc).__name__}: {exc}', retry_recipe=str(recipe), retry_media=str(clip))
            with self.lock:
                return not any(self.records[row['candidate_id']]['status'] == 'failed' for row in group)
        except luna.OperationalPause:
            self.pause_candidates(group, stage)
            return True
        except Exception as exc:
            for item in group:
                vid = item['candidate_id']
                if self.records.get(vid, {}).get('status') not in TERMINAL:
                    self.save(vid, 'failed', stage=stage, error=f'{type(exc).__name__}: {exc}', batch=str(batch))
            return False
        finally:
            with self.lock:
                self.active_batches.pop(batch.name, None)
            self.heartbeat()

    def run_batches(self):
        """Keep at most two whole batches in flight; drain on a failure stop."""
        slots = iter(self.batch_slots())
        completed = queue.Queue()
        active = set()
        submitted = failures = 0
        exhausted = False
        stop_error = None
        paused = False
        with ThreadPoolExecutor(max_workers=self.batch_workers) as pool:
            while True:
                while not stop_error and not exhausted and len(active) < self.batch_workers:
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
                    future = pool.submit(self.process_batch, batch, slot)
                    active.add(future)
                    future.add_done_callback(completed.put)
                    submitted += 1
                if not active:
                    break
                future = completed.get()
                active.remove(future)
                try:
                    succeeded = future.result()
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
        thread = threading.Thread(target=self.pulse, daemon=True)
        thread.start()
        try:
            luna.check_stop(self.root)
            stream_plan = self.stream_plan() if self.stream_id else None
            admitted_ids = set(stream_plan['candidate_ids']) if stream_plan else None
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
            self.phase = 'coverage_finished'
            verify(self.root)
        except luna.OperationalPause:
            self.phase, self.error = 'paused', None
            audit.atomic(self.root / 'pause-status.json', {'phase': 'paused', 'drained_at': audit.now(),
                'reason': 'Operator STOP.json; in-flight operations finished before return',
                'stream_id': self.stream_id, 'experiment_id': self.experiment_id})
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
    args = parser.parse_args()
    if args.private_env_file:
        private_environment(args.private_env_file)
    if args.verify:
        result = verify(args.root)
        print(json.dumps(result, indent=2))
        raise SystemExit(0 if result['passed'] else 1)
    args.root.mkdir(parents=True, exist_ok=True)
    with runner_lock(args.root / 'runner.lock'):
        Runner(args.root, args.whisper_cli, args.max_batches, args.machine, args.batch_namespace, args.batch_workers,
               args.experiment_id, args.stream_id, args.max_candidates).run()


if __name__ == '__main__':
    main()
