import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch, Mock
import production as p


class ProductionTests(unittest.TestCase):
    def fixture(self):
        source = {'transcript': '\n'.join(f'[{i}] word{i}' for i in range(0, 401, 10))}
        packet = {'candidate_id': 'abcdefghijk', 'source_input_hash': 'hash', 'title': 'AI',
                  'speaker_source': 'Speaker', 'luna_reason': 'AI claim', 'source_duration_seconds': 400,
                  'context_start_seconds': 0, 'context_end_seconds': 400,
                  'luna_proposal': {'start_seconds': 21, 'end_seconds': 61, 'claim': 'AI claim'}}
        return packet, source

    def test_outward_alignment_includes_all_captions_but_is_provisional(self):
        packet, source = self.fixture()
        recipe = p.seed(packet, source)
        edit = recipe['edits'][0]
        self.assertLessEqual(edit['start_seconds'], 21)
        self.assertGreaterEqual(edit['end_seconds'], 61)
        self.assertIn('PROVISIONAL', recipe['reason'])
        self.assertEqual(edit['transcript'], ' '.join(f'word{i}' for i in range(int(edit['start_seconds']), int(edit['end_seconds']), 10)))

    def test_never_silently_shrinks_an_oversize_proposal(self):
        packet, source = self.fixture()
        packet['luna_proposal'].update(start_seconds=0, end_seconds=241)
        with self.assertRaisesRegex(ValueError, '240'):
            p.seed(packet, source)

    def test_maximum_clip_does_not_get_padding_past_limit(self):
        packet, source = self.fixture()
        packet['luna_proposal'].update(start_seconds=20, end_seconds=260)
        edit = p.seed(packet, source)['edits'][0]
        self.assertEqual(edit['end_seconds'] - edit['start_seconds'], 240)

    def test_bad_timestamps_fail_closed(self):
        for a, b in [(float('nan'), 60), (-1, 60), (60, 60), (60, float('inf'))]:
            packet, source = self.fixture()
            packet['luna_proposal'].update(start_seconds=a, end_seconds=b)
            with self.subTest(a=a, b=b), self.assertRaises(ValueError):
                p.seed(packet, source)

    def test_live_receipt_rejects_missing_database_row(self):
        receipt = {'video_id': 'abcdefghijk', 'snippet_id': 'id', 'gcs_url': 'https://example.com/clip.mp4'}
        response = Mock(); response.json.return_value = []
        with patch('production.requests.get', return_value=response) as get:
            with self.assertRaisesRegex(ValueError, 'missing'):
                p.live_receipt(receipt)
            self.assertEqual(get.call_count, 1)

    def test_unresolved_is_coverage_but_not_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p.audit.atomic(root / 'input/manifest.json', {'candidates': [{'candidate_id': 'abcdefghijk'}]})
            p.audit.atomic(root / 'records/abcdefghijk.json', {'candidate_id': 'abcdefghijk', 'status': 'awaiting_astra'})
            result = p.verify(root)
            self.assertTrue(result['checks']['exact_coverage'])
            self.assertTrue(result['passed'])
            self.assertFalse(result['all_completed'])

    def test_failed_candidate_fails_verifier_despite_exact_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p.audit.atomic(root / 'input/manifest.json', {'candidates': [{'candidate_id': 'abcdefghijk'}]})
            p.audit.atomic(root / 'records/abcdefghijk.json', {'candidate_id': 'abcdefghijk', 'status': 'failed'})
            result = p.verify(root)
            self.assertTrue(result['checks']['exact_coverage'])
            self.assertFalse(result['checks']['operational_failures_resolved'])
            self.assertFalse(result['passed'])

    def test_runner_lock_excludes_second_process_and_releases(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'runner.lock'
            code = 'from production import runner_lock; import sys\nwith runner_lock(sys.argv[1]): pass'
            command = [sys.executable, '-X', 'utf8', '-c', code, str(path)]
            with p.runner_lock(path):
                result = subprocess.run(command, cwd=Path(p.__file__).parent, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
            result = subprocess.run(command, cwd=Path(p.__file__).parent, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_namespace_persists_and_rejects_changed_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(p.batch_namespace(root, 'shadow-codex'), 'shadow-codex')
            self.assertEqual(p.batch_namespace(root, None), 'shadow-codex')
            with self.assertRaisesRegex(ValueError, 'differs'):
                p.batch_namespace(root, 'other')
            with self.assertRaisesRegex(ValueError, 'simple name'):
                p.batch_namespace(root, '../other')

    def test_checkpoint_mapping_preserves_evidence_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            checkpoint = root / 'checkpoint'
            p.audit.atomic(root / 'checkpoint-paths.json', {'/Users/ori/run': str(checkpoint)})
            p.audit.atomic(checkpoint / 'publications/vid.json', {'path': '/Users/ori/run/clip.mp4'})
            before = (checkpoint / 'publications/vid.json').read_bytes()
            result = p.artifact_path(root, '/Users/ori/run/publications/vid.json')
            self.assertEqual(result, (checkpoint / 'publications/vid.json').resolve())
            self.assertEqual(result.read_bytes(), before)
            with self.assertRaisesRegex(ValueError, 'escapes'):
                p.artifact_path(root, '/Users/ori/run/../outside')

    def test_private_environment_supports_windows_paths_without_shell_execution(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            path = Path(tmp) / 'private.env'
            path.write_text('# private settings\nOPENAI_API_KEY="test-secret"\nGOOGLE_APPLICATION_CREDENTIALS=C:\\private\\key.json\n', encoding='utf-8-sig')
            p.private_environment(path)
            self.assertEqual(os.environ['OPENAI_API_KEY'], 'test-secret')
            self.assertEqual(os.environ['GOOGLE_APPLICATION_CREDENTIALS'], 'C:\\private\\key.json')
            path.write_text('UNEXPECTED_KEY=secret', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'unsupported'):
                p.private_environment(path)

    def test_checkpoint_terminal_records_are_never_prepared(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidates = [{'candidate_id': f'v{i:010}', 'lane': 'eligible'} for i in range(1644)]
            p.audit.atomic(root / 'input/manifest.json', {'candidates': candidates})
            p.audit.atomic(root / 'input/already-published.json', {c['candidate_id']: {} for c in candidates[:19]})
            p.audit.atomic(root / 'input/culled-ids.json', [])
            for i, item in enumerate(candidates):
                p.audit.atomic(root / 'records' / f"{item['candidate_id']}.json",
                               {**item, 'status': 'already_published' if i < 19 else 'awaiting_astra'})
            p.audit.atomic(root / 'checkpoint-status.json', {'luna_cost_usd': .125, 'unique_api_responses': 4})
            client = Mock()
            client.query.return_value.result.return_value = []
            with patch('production.audit.inputs', return_value=[]), patch('production.audit.bq_client', return_value=client), \
                 patch('production.Runner.prepare') as prepare, patch('production.luna.pipeline') as pipeline, \
                 patch('production.live_receipt') as live, patch('production.verify'):
                runner = p.Runner(root, 'whisper', machine='Shadow', namespace='shadow-codex')
                runner.run()
                prepare.assert_not_called()
                pipeline.assert_not_called()
                live.assert_not_called()
            status = p.luna.read(root / 'status.json')
            self.assertEqual(status['covered'], 1644)
            self.assertEqual(status['machine'], 'Shadow')
            self.assertEqual(status['luna_cost_usd'], .125)
            self.assertEqual(status['current_luna_cost_usd'], 0)
            self.assertEqual(status['unique_api_responses'], 4)

    def test_tiny_runner_completes_five_once_and_preserves_status_timing_on_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidates = [{'candidate_id': f'v{i:010}', 'lane': 'eligible' if i < 1200 else 'review'} for i in range(1644)]
            p.audit.atomic(root / 'input/manifest.json', {'candidates': candidates})
            p.audit.atomic(root / 'input/already-published.json', {})
            p.audit.atomic(root / 'input/culled-ids.json', [])
            job = Mock(job_id='preflight-offline', total_bytes_billed=0, cache_hit=True)
            job.result.return_value = []
            client = Mock(); client.query.return_value = job
            admitted = []
            def process(runner, batch, slot):
                for item in slot:
                    admitted.append(item['candidate_id'])
                    runner.save(item['candidate_id'], 'awaiting_astra', stage='proposal', reason='offline fixture')
                return True
            with patch('production.audit.inputs', return_value=[]), patch('production.audit.bq_client', return_value=client), \
                 patch.object(p.Runner, 'process_batch', process):
                runner = p.Runner(root, 'whisper', stream_id='tiny-test', max_candidates=5, batch_workers=2)
                runner.run()
                first = p.luna.read(root / 'stream-status.json')
                self.assertEqual(first['phase'], 'stream_completed')
                self.assertEqual(first['counts'], {'awaiting_astra': 5})
                self.assertEqual(len(admitted), 5)
                p.Runner(root, 'whisper', stream_id='tiny-test', max_candidates=5, batch_workers=2).run()
            second = p.luna.read(root / 'stream-status.json')
            self.assertEqual(second['started_at'], first['started_at'])
            self.assertEqual(len(second['attempts']), 2)
            self.assertEqual(len(admitted), 5)


class BatchResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.batch = self.root / 'batches' / 'shadow-eligible-0001'
        self.packets = self.root / 'input' / 'candidates'
        self.ids = ['first-id', 'second-id']
        self.directories = [self.root / 'rendered' / vid for vid in self.ids]
        self.decisions = []
        for vid, directory in zip(self.ids, self.directories):
            directory.mkdir(parents=True)
            (directory / 'clip.mp4').write_bytes(b'test exact media ' + vid.encode())
            p.audit.atomic(directory / 'recipe.json', {'candidate_id': vid})
            self.decisions.append({'candidate_id': vid, 'status': 'pass', 'complete': True,
                                   'media_path': str(directory / 'clip.mp4'), 'recipe_path': str(directory / 'recipe.json'),
                                   'media_sha256': p.luna.sha(directory / 'clip.mp4'),
                                   'recipe_hash': p.audit.digest({'candidate_id': vid}),
                                   'release_gate': {'policy_version': p.luna.RELEASE_POLICY_VERSION, 'passed': True,
                                                    'min_release_confidence': .95, 'release_confidence': .99, 'escalation_reasons': []}})
        self.packager = patch('production.luna.current_package', side_effect=lambda directory, packets:
                             {'evidence': {'candidate_id': Path(directory).name, 'evidence_hash': 'evidence-' + Path(directory).name}})
        self.packager.start()
        self.addCleanup(self.packager.stop)

    def plan(self):
        return p.bound_batch_plan(self.batch, self.ids, self.directories, self.packets)

    def completed(self, plan):
        result = {'run_hash': plan['run_hash'], 'release_policy_version': p.luna.RELEASE_POLICY_VERSION,
                  'min_release_confidence': .95, 'decisions': self.decisions, 'api_calls_this_invocation': 2,
                  'new_cost_usd': .01, 'cost_usd': .01}
        p.audit.atomic(self.batch / 'pipelines' / plan['run_hash'] / 'pipeline-results.json', result)
        return result

    def test_partial_resume_keeps_original_membership_and_identity(self):
        plan = self.plan()
        # First candidate may already be published; the caller's live subset
        # must not change the paid batch members or its cache identity.
        resumed = p.bound_batch_plan(self.batch, self.ids, self.directories[1:], self.packets)
        self.assertEqual(resumed, plan)
        self.assertEqual(resumed['directories'], [str(d.resolve()) for d in self.directories])

    def test_completed_partial_batch_resumes_without_paid_call(self):
        plan = self.plan()
        self.completed(plan)
        with patch('production.luna.pipeline') as pipeline:
            result = p.planned_pipeline(plan, self.batch, self.packets, 'whisper')
        pipeline.assert_not_called()
        self.assertEqual([d['candidate_id'] for d in result['decisions']], self.ids)
        self.assertEqual(result['api_calls_this_invocation'], 0)
        self.assertEqual(result['new_cost_usd'], 0)

    def test_ambiguous_resume_passes_exact_original_membership(self):
        plan = self.plan()
        p.audit.atomic(self.batch / 'request-hash' / 'call-state.json', {'status': 'started'})
        with patch('production.luna.pipeline', side_effect=ValueError('Prior API call has no durable response')) as pipeline:
            with self.assertRaisesRegex(ValueError, 'no durable response'):
                p.planned_pipeline(plan, self.batch, self.packets, 'whisper')
        args = pipeline.call_args.args[0]
        self.assertEqual(args.clips, self.directories)
        self.assertEqual(args.run_id, plan['run_id'])

    def test_paid_artifacts_without_membership_fail_closed(self):
        p.audit.atomic(self.batch / 'old-request' / 'call-state.json', {'status': 'started'})
        with self.assertRaisesRegex(ValueError, 'without frozen membership'):
            self.plan()

    def test_evidence_change_does_not_create_fresh_paid_identity(self):
        self.plan()
        with patch('production.luna.current_package', return_value={'evidence': {'candidate_id': 'first-id', 'evidence_hash': 'changed'}}):
            with self.assertRaisesRegex(ValueError, 'duplicate|changed'):
                self.plan()

    def test_changed_manifest_slot_is_rejected(self):
        self.plan()
        with self.assertRaisesRegex(ValueError, 'slot membership'):
            p.bound_batch_plan(self.batch, ['different-id'], None, self.packets)

    def test_cached_gate_and_media_are_still_checked(self):
        plan = self.plan()
        self.completed(plan)
        self.decisions[0]['release_gate']['release_confidence'] = .94
        self.completed(plan)
        with self.assertRaisesRegex(ValueError, 'release gate'):
            p.planned_pipeline(plan, self.batch, self.packets, 'whisper')
        self.decisions[0]['release_gate']['release_confidence'] = .99
        self.completed(plan)
        (self.directories[0] / 'clip.mp4').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'artifact hash drift'):
            p.planned_pipeline(plan, self.batch, self.packets, 'whisper')


class ConcurrentBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runner = p.Runner.__new__(p.Runner)
        self.runner.root = Path(self.temp.name)
        self.runner.input = self.runner.root / 'input'
        self.runner.namespace = 'test'
        self.runner.whisper = 'whisper'
        self.runner.lock = threading.RLock()
        self.runner.render_slots = p.luna.RENDER_LOCK
        self.runner.records = {}
        self.runner.active_ids = set()
        self.runner.active_batches = {}
        self.runner.batch_claims = set()
        self.runner.batch_workers = 2
        self.runner.review_barrier = None
        self.runner.publication_lock = threading.Lock()
        self.runner.limit = None
        self.runner.phase = 'processing_batches'
        self.runner.error = None
        self.runner.heartbeat = Mock()

        def save(vid, status, **values):
            with self.runner.lock:
                self.runner.records[vid] = {'candidate_id': vid, 'status': status, **values}
        self.runner.save = Mock(side_effect=save)

    def slots(self, count):
        return [(self.runner.root / f'batch{i}', [{'candidate_id': str(i)}]) for i in range(count)]

    def test_two_batches_run_concurrently_without_duplicate_submission(self):
        slots = self.slots(6)
        self.runner.batch_slots = lambda: iter(slots)
        lock = threading.Lock()
        active = maximum = 0
        seen = []

        def work(batch, slot):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(active, maximum)
                seen.append(batch.name)
            time.sleep(.025)
            with lock:
                active -= 1
            return True
        self.runner.process_batch = work
        self.assertTrue(self.runner.run_batches())
        self.assertEqual(maximum, 2)
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(set(seen), {batch.name for batch, _ in slots})

    def test_first_bounded_run_submits_only_one_even_with_two_workers(self):
        self.runner.limit = 1
        self.runner.batch_slots = lambda: iter(self.slots(5))
        self.runner.process_batch = Mock(return_value=True)
        self.assertFalse(self.runner.run_batches())
        self.assertEqual(self.runner.process_batch.call_count, 1)

    def test_three_failures_stop_new_batches_and_drain_fourth(self):
        self.runner.batch_slots = lambda: iter(self.slots(10))
        first_two = threading.Barrier(2)
        fourth_started = threading.Event()
        release_fourth = threading.Event()
        fourth_finished = threading.Event()
        seen = []

        def work(batch, slot):
            index = int(slot[0]['candidate_id'])
            seen.append(index)
            if index < 2:
                first_two.wait(timeout=3)
                return False
            if index == 2:
                self.assertTrue(fourth_started.wait(timeout=3))
                return False
            if index == 3:
                fourth_started.set()
                self.assertTrue(release_fourth.wait(timeout=3))
                fourth_finished.set()
                return True
            self.fail('Scheduled new work after the failure stop')

        def heartbeat():
            if self.runner.phase == 'draining_after_batch_failures':
                release_fourth.set()
        self.runner.process_batch = work
        self.runner.heartbeat = heartbeat
        with self.assertRaisesRegex(RuntimeError, 'Three consecutive'):
            self.runner.run_batches()
        self.assertEqual(sorted(seen), [0, 1, 2, 3])
        self.assertTrue(fourth_finished.is_set())

    def test_duplicate_batch_claim_cannot_make_second_paid_call(self):
        batch, slot = self.slots(1)[0]
        p.audit.atomic(batch / 'batch-plan.json', {'existing': True})
        entered, release = threading.Event(), threading.Event()
        plan = {'candidate_ids': ['0']}

        def pipeline(*args):
            entered.set()
            self.assertTrue(release.wait(timeout=3))
            return {'decisions': [{'candidate_id': '0', 'status': 'review', 'complete': False,
                                   'astra_escalation_path': 'handoff.md', 'reason': 'hold'}]}
        with patch('production.bound_batch_plan', return_value=plan) as bound, \
             patch('production.planned_pipeline', side_effect=pipeline) as paid:
            with ThreadPoolExecutor(max_workers=1) as pool:
                first = pool.submit(self.runner.process_batch, batch, slot)
                try:
                    self.assertTrue(entered.wait(timeout=3))
                    with self.assertRaisesRegex(RuntimeError, 'already submitted'):
                        self.runner.process_batch(batch, slot)
                finally:
                    release.set()
                self.assertTrue(first.result(timeout=3))
            self.assertEqual(paid.call_count, 1)
            self.assertEqual(bound.call_args.args[1], ['0'])
            self.assertIsNone(bound.call_args.args[2])
            self.assertEqual(self.runner.records['0']['status'], 'awaiting_astra')
            self.assertEqual(self.runner.active_batches, {})

    def test_slot_membership_stays_five_when_some_candidates_are_terminal(self):
        self.runner.candidates = [{'candidate_id': str(i), 'lane': 'eligible'} for i in range(10)]
        self.runner.records = {str(i): {'status': 'already_published'} for i in range(6)}
        slots = list(self.runner.batch_slots())
        self.assertEqual(len(slots), 1)
        self.assertEqual(slots[0][0].name, 'test-eligible-0002')
        self.assertEqual([item['candidate_id'] for item in slots[0][1]], ['5', '6', '7', '8', '9'])

    def test_shared_render_slots_bound_parallel_preparation_to_two(self):
        items = [{'candidate_id': str(i), 'packet_sha256': p.audit.digest({'id': i})} for i in range(6)]
        self.runner.sources = {str(i): {} for i in range(6)}
        self.runner.forbidden = set()
        for i in range(6):
            p.audit.atomic(self.runner.input / 'candidates' / f'{i}.json', {'id': i})
        active = maximum = 0
        lock = threading.Lock()

        def render(args, recipe, packet, valid):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(.025)
            with lock:
                active -= 1
            return {'clip_path': str(self.runner.root / 'rendered' / str(packet['id']) / 'clip.mp4'),
                    'transfer': {}, 'output_bytes': 1}
        with patch('production.seed', return_value={}), patch('production.media.validate'), \
             patch('production.media.render', side_effect=render), patch('production.luna.ensure_asr'), \
             patch('production.luna.contact_sheet'):
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(self.runner.prepare, items))
        self.assertTrue(all(results))
        self.assertEqual(maximum, 2)
        self.assertIs(self.runner.render_slots, p.luna.RENDER_LOCK)

    def test_low_disk_marks_named_failure_without_rendering(self):
        with patch('production.shutil.disk_usage', return_value=p.SimpleNamespace(free=0)), \
             patch('production.media.render') as render:
            self.assertIsNone(self.runner.prepare({'candidate_id': 'disk-id'}))
            render.assert_not_called()
        self.assertEqual(self.runner.records['disk-id']['stage'], 'disk_space_low')

    def test_stop_before_preparation_admits_no_work_or_false_failure(self):
        p.audit.atomic(self.runner.root / 'STOP.json', {'reason': 'operator pause'})
        with patch('production.media.render') as render:
            self.assertIsNone(self.runner.prepare({'candidate_id': 'new-id'}))
            render.assert_not_called()
        self.assertNotIn('new-id', self.runner.records)

    def test_active_render_finishes_receipt_then_pauses_before_asr(self):
        self.runner.save = p.Runner.save.__get__(self.runner)
        item = {'candidate_id': 'vid', 'packet_sha256': p.audit.digest({'id': 'vid'})}
        self.runner.sources, self.runner.forbidden = {'vid': {}}, set()
        p.audit.atomic(self.runner.input / 'candidates/vid.json', {'id': 'vid'})
        directory = self.runner.root / 'rendered/vid'

        def render(*args):
            p.audit.atomic(self.runner.root / 'STOP.json', {'reason': 'drain'})
            return {'clip_path': str(directory / 'clip.mp4'), 'transfer': {'complete': True}, 'output_bytes': 42}

        with patch('production.seed', return_value={}), patch('production.media.validate'), \
             patch('production.media.render', side_effect=render), patch('production.luna.ensure_asr') as asr:
            self.assertIsNone(self.runner.prepare(item))
            asr.assert_not_called()
        row = self.runner.records['vid']
        self.assertEqual(row['status'], 'paused')
        self.assertEqual(row['previous_status'], 'transcribing')
        self.assertEqual(row['pause_stage'], 'preparation')
        self.assertEqual(row['directory'], str(directory))
        self.assertEqual(row['transfer'], {'complete': True})

    def test_stop_drains_active_batches_and_never_schedules_next(self):
        self.runner.batch_slots = lambda: iter(self.slots(6))
        admitted = []
        barrier = threading.Barrier(2)
        stopped = threading.Event()

        def work(batch, slot):
            admitted.append(batch.name)
            barrier.wait(timeout=3)
            if batch.name == 'batch0':
                p.audit.atomic(self.runner.root / 'STOP.json', {'reason': 'drain'})
                stopped.set()
            self.assertTrue(stopped.wait(timeout=3))
            time.sleep(.02)
            return True
        self.runner.process_batch = work
        with self.assertRaises(p.luna.OperationalPause):
            self.runner.run_batches()
        self.assertEqual(set(admitted), {'batch0', 'batch1'})

    def test_tiny_stream_excludes_entire_prior_fifty_and_never_reselects(self):
        self.runner.stream_id, self.runner.max_candidates = 'tiny-one', 5
        self.runner.candidates = [{'candidate_id': str(i), 'lane': 'eligible' if i < 60 else 'review'} for i in range(100)]
        p.audit.atomic(self.runner.input / 'manifest.json', {'candidates': self.runner.candidates})
        previous = {'candidate_ids': [str(i) for i in range(35)] + [str(i) for i in range(60, 75)]}
        previous['plan_sha256'] = p.audit.digest(previous)
        p.audit.atomic(self.runner.root / 'experiment-plan.json', previous)
        self.runner.records = {'35': {'status': 'paused'}}
        p.audit.atomic(self.runner.root / 'records/35.json', self.runner.records['35'])
        plan = self.runner.stream_plan()
        self.assertEqual([slot['candidate_ids'] for slot in plan['slots']], [['36', '37', '38'], ['75', '76']])
        self.assertFalse(set(plan['candidate_ids']) & set(previous['candidate_ids']))
        self.runner.records.update({vid: {'status': 'published'} for vid in plan['candidate_ids']})
        self.assertEqual(self.runner.stream_plan(), plan)
        self.assertEqual(list(self.runner.batch_slots()), [])
        self.runner.stream_id = 'tiny-two'
        with self.assertRaisesRegex(ValueError, 'Frozen streaming identity'):
            self.runner.stream_plan()

    def test_tiny_stream_requires_proven_prior_drain(self):
        p.audit.atomic(self.runner.root / 'experiment-plan.json', {'experiment_id': 'bounded-ten'})
        with self.assertRaisesRegex(ValueError, 'queue continuation is paused'):
            p.Runner(self.runner.root, 'whisper', stream_id='tiny-one', max_candidates=5, batch_workers=2)

    def test_drained_benchmark_cannot_restart_even_without_stop_file(self):
        p.audit.atomic(self.runner.root / 'experiment-plan.json', {'experiment_id': 'bounded-ten'})
        p.audit.atomic(self.runner.root / 'experiment-status.json',
                       {'experiment_id': 'bounded-ten', 'phase': 'paused', 'drained_at': p.audit.now()})
        with self.assertRaisesRegex(ValueError, 'scope remains closed'):
            p.Runner(self.runner.root, 'whisper', limit=10, batch_workers=10, experiment_id='bounded-ten')

    def test_stop_after_saved_pipeline_does_not_publish_or_mark_failed(self):
        batch, slot = self.slots(1)[0]
        p.audit.atomic(batch / 'batch-plan.json', {'existing': True})
        def pipeline(*args):
            p.audit.atomic(self.runner.root / 'STOP.json', {'reason': 'drain'})
            return {'decisions': [{'candidate_id': '0', 'status': 'pass', 'complete': True}]}
        with patch('production.bound_batch_plan', return_value={'candidate_ids': ['0']}), \
             patch('production.planned_pipeline', side_effect=pipeline), patch('production.publish_astra.publish') as publish:
            self.assertTrue(self.runner.process_batch(batch, slot))
            publish.assert_not_called()
        self.assertEqual(self.runner.records['0']['status'], 'paused')
        self.assertEqual(self.runner.records['0']['previous_status'], 'reviewing')

    def test_tiny_groups_stream_review_while_other_group_prepares(self):
        slots = [(self.runner.root / 'tiny-eligible', [{'candidate_id': str(i), 'lane': 'eligible'} for i in range(3)]),
                 (self.runner.root / 'tiny-review', [{'candidate_id': str(i), 'lane': 'review'} for i in range(3, 5)])]
        self.runner.batch_slots = lambda: iter(slots)
        review_started = threading.Event()
        order = []
        def prepare(item):
            if item['lane'] == 'eligible':
                self.assertTrue(review_started.wait(timeout=3))
            order.append('prepared-' + item['candidate_id'])
            return self.runner.root / 'rendered' / item['candidate_id']
        def pipeline(plan, batch, *args):
            if batch.name == 'tiny-review':
                order.append('review-started')
                review_started.set()
            return {'decisions': [{'candidate_id': vid, 'status': 'review', 'complete': False,
                                  'astra_escalation_path': 'hold.md', 'reason': 'hold'} for vid in plan['candidate_ids']]}
        self.runner.prepare = prepare
        with patch('production.bound_batch_plan', side_effect=lambda batch, ids, *args: {'candidate_ids': ids}), \
             patch('production.planned_pipeline', side_effect=pipeline):
            self.assertTrue(self.runner.run_batches())
        self.assertLess(order.index('review-started'), order.index('prepared-0'))
        self.assertEqual(len(self.runner.records), 5)

    def test_publication_inflight_finishes_readback_and_record_after_stop(self):
        batch, slot = self.slots(1)[0]
        p.audit.atomic(batch / 'batch-plan.json', {'existing': True})
        decision = {'candidate_id': '0', 'status': 'pass', 'complete': True,
                    'recipe_path': str(self.runner.root / 'recipe.json'), 'media_path': str(self.runner.root / 'clip.mp4')}
        def publish(*args):
            p.audit.atomic(self.runner.root / 'STOP.json', {'reason': 'drain'})
        with patch('production.bound_batch_plan', return_value={'candidate_ids': ['0']}), \
             patch('production.planned_pipeline', return_value={'decisions': [decision]}), \
             patch('production.publish_astra.publish', side_effect=publish), patch('production.live_receipt') as live, \
             patch('production.luna.read', return_value={'passed': True}):
            self.assertTrue(self.runner.process_batch(batch, slot))
        live.assert_called_once()
        self.assertEqual(self.runner.records['0']['status'], 'published')

    def test_stop_during_benchmark_preparation_does_not_freeze_partial_paid_batch(self):
        batch, slot = self.slots(1)[0]
        def prepare(item):
            self.runner.records[item['candidate_id']] = {'status': 'prepared'}
            p.audit.atomic(self.runner.root / 'STOP.json', {})
            return self.runner.root / 'rendered' / item['candidate_id']
        self.runner.prepare = prepare
        with patch('production.bound_batch_plan') as bound:
            self.runner.prepare_experiment_batch(batch, slot)
            bound.assert_not_called()
        self.assertEqual(self.runner.records['0']['status'], 'paused')

    def test_frozen_experiment_blocks_old_unlimited_continuation_command(self):
        p.audit.atomic(self.runner.root / 'experiment-plan.json', {'experiment_id': 'bounded-ten'})
        with self.assertRaisesRegex(ValueError, 'queue continuation is paused'):
            p.Runner(self.runner.root, 'whisper')

    def test_publication_readback_and_saved_state_are_serialized(self):
        slots = self.slots(2)
        for batch, slot in slots:
            p.audit.atomic(batch / 'batch-plan.json', {'existing': True})
        active = maximum = 0
        mutex = threading.Lock()

        def publish(*args):
            nonlocal active, maximum
            with mutex:
                active += 1
                maximum = max(maximum, active)
            time.sleep(.02)

        def live(receipt):
            nonlocal active
            # The publication lock must cover readback, not only the upload.
            time.sleep(.01)
            with mutex:
                active -= 1

        def pipeline(plan, *args):
            vid = plan['candidate_ids'][0]
            return {'decisions': [{'candidate_id': vid, 'status': 'pass', 'complete': True,
                'recipe_path': str(self.runner.root / vid / 'recipe.json'),
                'media_path': str(self.runner.root / vid / 'clip.mp4')}]}

        with patch('production.bound_batch_plan', side_effect=lambda batch, ids, *args: {'candidate_ids': ids}), \
             patch('production.planned_pipeline', side_effect=pipeline), patch('production.publish_astra.publish', side_effect=publish), \
             patch('production.live_receipt', side_effect=live), patch('production.luna.read', return_value={'passed': True}):
            with ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(lambda pair: self.runner.process_batch(*pair), slots))
        self.assertTrue(all(outcomes))
        self.assertEqual(maximum, 1)
        self.assertEqual({row['status'] for row in self.runner.records.values()}, {'published'})

    def test_experiment_resume_keeps_frozen_fifty_and_baseline_hashes(self):
        self.runner.experiment_id = 'bounded-ten'
        self.runner.candidates = [{'candidate_id': str(i), 'lane': 'eligible' if i < 80 else 'review'} for i in range(100)]
        self.runner.responses = {'old-response': .01}
        self.runner.checkpoint_status = {'luna_cost_usd': .02}
        p.audit.atomic(self.runner.input / 'manifest.json', {'candidates': self.runner.candidates})
        self.runner.save('0', 'already_published')
        p.audit.atomic(self.runner.root / 'records/0.json', self.runner.records['0'])
        p.audit.atomic(self.runner.root / 'mac-checkpoint/batches/mac-batch/request-hash/response.json', {'id': 'mac-response'})
        plan = self.runner.experiment_plan()
        self.assertEqual(plan['candidate_ids'], [str(i) for i in range(1, 36)] + [str(i) for i in range(80, 95)])
        self.assertEqual(len(plan['slots']), 10)
        self.assertEqual([slot['lane'] for slot in plan['slots']], ['eligible'] * 7 + ['review'] * 3)
        self.assertEqual(plan['baseline_response_ids'], ['mac-response', 'old-response'])
        self.assertEqual(plan['baseline_record_sha256']['0'], p.luna.sha(self.runner.root / 'records/0.json'))
        for vid in plan['candidate_ids'][:15]:
            self.runner.save(vid, 'published')
        resumed = self.runner.experiment_plan()
        self.assertEqual(resumed, plan)
        self.runner.experiment_id = 'new-experiment'
        with self.assertRaisesRegex(ValueError, 'Frozen experiment'):
            self.runner.experiment_plan()

    def test_all_preparation_settles_before_ten_review_workers_are_released(self):
        self.runner.experiment_id = 'bounded-ten'
        self.runner.batch_workers = 10
        self.runner.limit = 10
        slots = [{'batch_name': f'batch{i}', 'items': [{'candidate_id': str(i)}]} for i in range(10)]
        self.runner.experiment_plan = Mock(return_value={'slots': slots})
        prepared = set()
        lock = threading.Lock()
        simultaneous = threading.Barrier(10)
        reviewed = []

        def prepare(batch, slot):
            time.sleep(.005)
            with lock:
                prepared.add(batch.name)

        def review(batch, slot):
            self.assertEqual(len(prepared), 10)
            simultaneous.wait(timeout=3)
            reviewed.append(batch.name)
            return True
        self.runner.prepare_experiment_batch = prepare
        self.runner.process_batch = review
        self.runner.run_experiment()
        self.assertEqual(len(set(reviewed)), 10)
        status = p.luna.read(self.runner.root / 'experiment-status.json')
        self.assertTrue(status['remaining_queue_paused_for_cost_confirmation'])
        self.assertLessEqual(status['preparation_finished_at'], status['review_started_at'])
        self.assertEqual(status['phase'], 'experiment_completed')


class CooperativeTransportTests(unittest.TestCase):
    def invoke(self, root, post, sleep=None):
        with patch.object(p.luna, 'build_request', return_value={'model': 'gpt-6-luna'}), \
             patch.object(p.luna, 'bind_request'), patch.object(p.audit, 'api_key', return_value='test'), \
             patch.object(p.luna, 'normalize', return_value={'decisions': []}), \
             patch('requests.post', side_effect=post) as request, patch.object(p.luna.time, 'sleep', side_effect=sleep):
            result = p.luna.review_packages([], root / 'batches/test')
        return result, request

    def test_stop_before_request_writes_no_call_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p.audit.atomic(root / 'STOP.json', {})
            with self.assertRaises(p.luna.OperationalPause):
                self.invoke(root, lambda *a, **k: self.fail('HTTP admitted after stop'))
            self.assertFalse(list(root.rglob('call-state.json')))

    def test_inflight_response_is_saved_even_if_stop_arrives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            response = Mock(status_code=200)
            response.json.return_value = {'id': 'resp_drained'}
            def post(*args, **kwargs):
                p.audit.atomic(root / 'STOP.json', {})
                return response
            _, request = self.invoke(root, post)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(p.luna.read(next(root.rglob('response.json')))['id'], 'resp_drained')
            self.assertEqual(p.luna.read(next(root.rglob('call-state.json')))['status'], 'response_saved')

    def test_stop_during_429_wait_prevents_next_attempt_without_unknown_charge(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            response = Mock(status_code=429, headers={'Retry-After': '0'})
            calls = []
            def post(*args, **kwargs):
                calls.append(1)
                return response
            with self.assertRaises(p.luna.OperationalPause):
                self.invoke(root, post, lambda delay: p.audit.atomic(root / 'STOP.json', {}))
            self.assertEqual(calls, [1])
            self.assertEqual(p.luna.read(next(root.rglob('call-state.json')))['status'], 'rate_limited')

    def test_stop_after_intent_is_truthfully_receipted_as_not_dispatched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = p.luna.check_stop
            def check(directory):
                if list(root.rglob('transport-events.jsonl')):
                    p.audit.atomic(root / 'STOP.json', {})
                original(directory)
            with patch.object(p.luna, 'check_stop', side_effect=check), self.assertRaises(p.luna.OperationalPause):
                self.invoke(root, lambda *a, **k: self.fail('HTTP was dispatched'))
            state = p.luna.read(next(root.rglob('call-state.json')))
            self.assertEqual(state['status'], 'cancelled_before_dispatch')
            self.assertFalse(state['dispatched'])
            self.assertFalse(state['charge_unknown'])
            events = [json.loads(line) for line in next(root.rglob('transport-events.jsonl')).read_text().splitlines()]
            self.assertEqual(events[-1]['event'], 'request_end')
            self.assertFalse(events[-1]['dispatched'])

    def test_legacy_review_cli_checks_stop_before_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            clip = root / 'rendered/vid'
            p.audit.atomic(clip / 'result.json', {'candidate_id': 'vid'})
            p.audit.atomic(root / 'STOP.json', {})
            argv = ['luna_batch_qa.py', 'review', '--clips', str(clip), '--output', str(root / 'batches')]
            with patch.object(sys, 'argv', argv), patch.object(p.luna, 'package', return_value={'evidence': {}}), \
                 patch.object(p.luna, 'build_request', return_value={'model': 'gpt-6-luna'}), patch('requests.post') as post:
                with self.assertRaises(p.luna.OperationalPause):
                    p.luna.main()
                post.assert_not_called()


if __name__ == '__main__':
    unittest.main()
