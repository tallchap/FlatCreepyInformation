import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import audit
import fixed_subset_checkpoint as checkpoint
import supervise_continuation as supervisor_module


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    audit.atomic(path, value)
    return path


class FixedSubsetCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root, self.cont, self.output = base / 'run', base / 'continuation', base / 'checkpoints'
        self.root.mkdir()
        self.cont.mkdir()
        self.ids = [f'{number:011d}' for number in range(340)]
        ids_path = self.cont / 'selected-ids.txt'
        ids_path.write_text('\n'.join(self.ids) + '\n', encoding='ascii', newline='\n')
        ids_sha = hashlib.sha256(ids_path.read_bytes()).hexdigest()
        write(self.cont / 'authorization.json', {'scope': 'fixed_subset_frozen_manifest',
            'job_id': 'FIXED', 'selected_ids_file': 'selected-ids.txt',
            'selected_ids_sha256': ids_sha, 'broad_owner_handoff': {}})
        write(self.cont / 'continuation-plan.json', {'continuation_id': 'FIXED',
            'authorized_candidate_ids': self.ids, 'plan_sha256': 'a' * 64,
            'preflight_holds': [], 'mixed_batch_inventories': [],
            'slots': [{'batch_name': 'FIXED-eligible-0001',
                       'candidate_ids': self.ids[:2]}]})
        write(self.cont / 'preflight-reconciliation.json', {'selected_records': {
            self.ids[0]: {'status': 'awaiting_astra'}}})
        write(self.cont / 'status.json', {'phase': 'running'})
        for folder in ('records', 'publications', 'publication-attempts', 'recipes',
                       'input/candidates', 'batches'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        write(self.root / 'records' / f'{self.ids[0]}.json',
              {'candidate_id': self.ids[0], 'status': 'awaiting_astra'})
        write(self.root / 'records' / f'{self.ids[1]}.json',
              {'candidate_id': self.ids[1], 'status': 'failed', 'reason': 'source unavailable'})
        write(self.root / 'records' / 'outsider000.json',
              {'candidate_id': 'outsider000', 'status': 'published'})
        write(self.root / 'publications' / f'{self.ids[0]}.json',
              {'video_id': self.ids[0], 'passed': True})
        write(self.root / 'publication-attempts' / f'{self.ids[0]}.json',
              {'video_id': self.ids[0], 'status': 'committed'})
        write(self.root / 'recipes' / f'{self.ids[0]}.json', {'candidate_id': self.ids[0]})
        write(self.root / 'input/candidates' / f'{self.ids[1]}.json',
              {'candidate_id': self.ids[1]})
        fixed = self.root / 'batches' / 'FIXED-eligible-0001' / 'finalizer'
        write(fixed / 'response.json', {'id': 'resp_fixed', 'model': 'gpt-6-luna',
                                        'status': 'completed', 'usage': {'total_tokens': 2}})
        write(fixed / 'call-state.json', {'status': 'completed'})
        write(fixed / 'request.json', {'api_key': 'must-not-be-read'})
        broad = self.root / 'batches' / 'BROAD-eligible-9999' / 'finalizer'
        write(broad / 'response.json', {'id': 'resp_broad', 'model': 'gpt-6-luna'})

    def tearDown(self):
        self.temp.cleanup()

    def test_checkpoint_is_selected_and_fixed_batch_only(self):
        result = checkpoint.create_checkpoint(self.root, self.cont, self.output)
        bundle = Path(result['directory'])
        self.assertTrue((bundle / 'selected-records' / f'{self.ids[0]}.json').is_file())
        self.assertFalse((bundle / 'selected-records' / 'outsider000.json').exists())
        self.assertTrue((bundle / 'selected-evidence/publications' / f'{self.ids[0]}.json').is_file())
        self.assertTrue((bundle / 'fixed-plan-batches/FIXED-eligible-0001/finalizer/response.json').is_file())
        self.assertFalse(any('BROAD-eligible' in str(path) for path in bundle.rglob('*')))
        self.assertFalse(any(path.name == 'request.json' for path in bundle.rglob('*')))
        partition = checkpoint.load(bundle / 'partition.json')
        self.assertEqual(self.ids[:2], partition['new_fallback_ids_in_this_checkpoint'])
        self.assertEqual([], partition['previously_delivered_fallback_ids'])
        index = checkpoint.load(bundle / 'fallbacks' / self.ids[1] / 'index.json')
        self.assertTrue(index['new_in_this_checkpoint'])
        self.assertFalse(index['audio']['included'])
        self.assertIn('current clip', index['audio']['omission_reason'])

        checkpoint.mark_delivered(self.cont, result)
        second = checkpoint.create_checkpoint(self.root, self.cont, self.output)
        self.assertEqual([], second['new_fallback_ids'])
        state = checkpoint.load(self.cont / checkpoint.STATE_NAME)
        self.assertEqual([self.ids[0], self.ids[1]], state['delivered_fallback_ids'])

    def test_plan_cannot_name_off_scope_batch_member(self):
        plan_path = self.cont / 'continuation-plan.json'
        plan = checkpoint.load(plan_path)
        plan['slots'][0]['candidate_ids'].append('outsider000')
        write(plan_path, plan)
        with self.assertRaisesRegex(ValueError, 'off-scope'):
            checkpoint.create_checkpoint(self.root, self.cont, self.output)

    @mock.patch.object(checkpoint.subprocess, 'run')
    def test_lossless_audio_is_written_only_to_checkpoint_and_full_decode_checked(self, run):
        source = self.root / 'rendered/current/clip.mp4'
        source.parent.mkdir(parents=True)
        source.write_bytes(b'unchanged-current-video')
        ffmpeg = Path(self.temp.name) / 'ffmpeg.exe'
        ffmpeg.write_bytes(b'fixture')
        target = self.output / 'packet/audio/current.flac'

        def invoke(command, **_kwargs):
            if '-c:a' in command:
                Path(command[-1]).parent.mkdir(parents=True, exist_ok=True)
                Path(command[-1]).write_bytes(b'lossless-full-audio')
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        run.side_effect = invoke
        evidence = checkpoint.extract_lossless_audio(ffmpeg, source, checkpoint.sha(source), target)
        self.assertTrue(evidence['included'])
        self.assertTrue(evidence['full_decode_passed'])
        self.assertEqual(b'unchanged-current-video', source.read_bytes())
        self.assertEqual(b'lossless-full-audio', target.read_bytes())
        self.assertEqual(2, run.call_count)


class FixedSupervisorCheckpointTests(unittest.TestCase):
    def supervisor(self):
        instance = object.__new__(supervisor_module.Supervisor)
        instance.scope = {'scope': 'fixed_subset_frozen_manifest'}
        instance.root = Path('run')
        instance.cont = Path('continuation')
        instance.checkpoint_dir = Path('checkpoints')
        instance.config = {'job_id': 'FIXED', 'ffmpeg': 'ffmpeg', 'runtime_commit': 'a' * 40,
                           'instance': 'shadow', 'origin': 'mac'}
        instance.relay = mock.Mock()
        instance.save = mock.Mock()
        instance.coverage = mock.Mock(return_value={'covered': 17})
        instance.state = {}
        instance.state_lock = supervisor_module.threading.RLock()
        instance.exit = supervisor_module.threading.Event()
        instance.finished = False
        instance.runner = instance.server = instance.endpoint = None
        instance.pending_final_response = None
        instance.reader_thread = instance.worker_thread = None
        instance.background_threads_quiesced = True
        return instance

    def final_response_fixture(self, base):
        instance = self.supervisor()
        instance.root, instance.cont = base / 'run', base / 'continuation'
        instance.checkpoint_dir = base / 'checkpoints'
        instance.root.mkdir()
        instance.cont.mkdir()
        instance.pending_final_response = {'prepared': True}
        instance.scope = {'scope': 'fixed_subset_frozen_manifest',
            'authorization_file_sha256': '1' * 64,
            'continuation_plan_file_sha256': '2' * 64}
        instance.validate_scope_authority = mock.Mock(return_value=instance.scope)
        snapshot_dir = instance.checkpoint_dir / 'final-fixed-bundle'
        manifest_path = write(snapshot_dir / 'checkpoint-manifest.json', {
            'schema_version': 'snippy-fixed-subset-checkpoint-v2',
            'job_id': 'FIXED', 'final': True, 'manifest_sha256': 'b' * 64})
        snapshot = {'directory': str(snapshot_dir), 'manifest_sha256': 'b' * 64,
            'manifest_file_sha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            'new_fallback_ids': [], 'job_id': 'FIXED',
            'selected_ids_sha256': 'd' * 64, 'final': True}
        instance.checkpoint = mock.Mock(return_value=snapshot)
        write(instance.root / 'STOP.json', {'job_id': 'FIXED', 'reason': 'complete'})
        write(instance.cont / 'final-verification.json', {'passed': True})
        owner = {'schema_version': 'snippy-production-owner-v1', 'job_id': 'FIXED',
            'pid': supervisor_module.os.getpid(), 'runtime_commit': 'a' * 40,
            'continuation_authorization': {
                'path': str((instance.cont / 'authorization.json').resolve()),
                'sha256': '1' * 64},
            'continuation_plan': {
                'path': str((instance.cont / 'continuation-plan.json').resolve()),
                'sha256': '2' * 64},
            'lock_path': str((instance.root / 'production-owner.lock').resolve()),
            'created_at': '2026-10-01T00:00:00Z', 'active': False,
            'released_at': '2026-10-01T00:01:00Z'}
        owner['owner_record_sha256'] = supervisor_module.object_digest(owner)
        write(instance.root / 'production-owner.json', owner)
        write(instance.cont / 'production-owner.json', owner)
        return instance, snapshot

    @mock.patch('fixed_subset_checkpoint.mark_delivered')
    @mock.patch('fixed_subset_checkpoint.create_checkpoint')
    def test_live_fixed_checkpoint_sends_bounded_bundle(self, create, mark):
        create.return_value = {'directory': 'bundle', 'recorded_candidates': 17,
            'manifest_sha256': 'b' * 64, 'manifest_file_sha256': 'c' * 64,
            'new_fallback_ids': ['00000000001']}
        instance = self.supervisor()
        result = instance.checkpoint()
        create.assert_called_once_with(instance.root, instance.cont, instance.checkpoint_dir,
                                       ffmpeg='ffmpeg', final=False)
        instance.relay.assert_called_once()
        self.assertEqual('send', instance.relay.call_args.args[0])
        mark.assert_called_once_with(instance.cont, result)

    @mock.patch('fixed_subset_checkpoint.mark_delivered')
    @mock.patch('fixed_subset_checkpoint.create_checkpoint')
    def test_final_fixed_checkpoint_waits_for_respond_before_marking(self, create, mark):
        create.return_value = {'directory': 'bundle', 'recorded_candidates': 340,
            'manifest_sha256': 'b' * 64, 'manifest_file_sha256': 'c' * 64,
            'new_fallback_ids': []}
        instance = self.supervisor()
        result = instance.checkpoint(final=True)
        self.assertEqual('bundle', result['directory'])
        instance.relay.assert_not_called()
        mark.assert_not_called()

    @mock.patch.object(supervisor_module.subprocess, 'run')
    def test_fixed_finalize_defers_response_until_owner_release(self, run):
        run.return_value = SimpleNamespace(returncode=0, stdout='verified', stderr='')
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            instance = self.supervisor()
            instance.root, instance.cont = base / 'run', base / 'continuation'
            instance.root.mkdir()
            instance.cont.mkdir()
            broad = instance.root / 'batches/BROAD/finalizer/response.json'
            write(broad, {'id': 'must-not-be-copied'})
            instance.scripts = Path(supervisor_module.__file__).resolve().parent
            instance.env = {}
            instance.finished = False
            instance.pending_final_response = None
            write(instance.cont / 'final-verification.json', {'passed': True})
            snapshot = {'directory': str(base / 'fixed-bundle'), 'manifest_sha256': 'b' * 64,
                'manifest_file_sha256': 'c' * 64, 'new_fallback_ids': [],
                'job_id': 'FIXED', 'selected_ids_sha256': 'd' * 64, 'final': False}
            instance.checkpoint = mock.Mock(return_value=snapshot)
            instance.finalize()
            self.assertTrue(instance.finished)
            instance.checkpoint.assert_called_once_with(final=False)
            instance.relay.assert_not_called()
            self.assertEqual('c' * 64,
                             instance.pending_final_response['prefinal_checkpoint_manifest_sha256'])
            self.assertFalse((instance.cont / 'final-delivery').exists())

    @mock.patch('publish_astra.lock_is_held', return_value=False)
    def test_fixed_terminal_response_contains_released_owner_proof(self, lock_held):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            instance, snapshot = self.final_response_fixture(base)
            response_id = 'R-0123456789abcdef'

            def relay(command, *_arguments):
                self.assertEqual('respond', command)
                self.assertTrue((instance.cont / 'final-response-intent.json').is_file())
                return 'ack: python relay.py ack FIXED --response-id ' + response_id

            instance.relay = mock.Mock(side_effect=relay)

            instance.submit_fixed_final_response()

            instance.checkpoint.assert_called_once_with(final=True)
            self.assertEqual('respond', instance.relay.call_args.args[0])
            self.assertEqual(snapshot['directory'], instance.relay.call_args.args[2])
            release = Path(instance.relay.call_args.args[3])
            receipt = checkpoint.load(release / 'owner-release-receipt.json')
            self.assertFalse(receipt['owner_active'])
            self.assertEqual({'production_owner': True, 'publication': True, 'supervisor': True},
                             receipt['locks_free'])
            intent = checkpoint.load(instance.cont / 'final-response-intent.json')
            self.assertEqual('accepted', intent['status'])
            self.assertEqual(response_id, intent['response_id'])
            self.assertEqual([], intent['snapshot_new_fallback_ids'])
            self.assertEqual(3, lock_held.call_count)

    @mock.patch('publish_astra.lock_is_held', return_value=False)
    def test_failed_respond_reconciles_matching_canonical_ready_response(self, _lock_held):
        with tempfile.TemporaryDirectory() as temporary:
            instance, _snapshot = self.final_response_fixture(Path(temporary))
            response_id = 'R-fedcba9876543210'

            def relay(command, *_arguments):
                if command == 'respond':
                    self.assertTrue((instance.cont / 'final-response-intent.json').is_file())
                    raise RuntimeError('transport result unknown')
                if command == 'show':
                    intent = checkpoint.load(instance.cont / 'final-response-intent.json')
                    return ('---\n'
                            'id: FIXED\n'
                            'status: READY\n'
                            'owner_instance: shadow\n'
                            'posted_by: mac\n'
                            f'response_id: {response_id}\n'
                            'response_outcome: success\n'
                            f'response_note: {intent["note"]}\n'
                            'responded_by: shadow\n'
                            '---\n## Log\n')
                self.fail('Unexpected Relay command: ' + command)

            instance.relay = mock.Mock(side_effect=relay)
            instance.submit_fixed_final_response()

            self.assertEqual(['respond', 'show'],
                             [call.args[0] for call in instance.relay.call_args_list])
            intent = checkpoint.load(instance.cont / 'final-response-intent.json')
            self.assertEqual('accepted', intent['status'])
            self.assertEqual(response_id, intent['response_id'])
            self.assertTrue(intent['accepted_via_reconciliation'])
            self.assertEqual(response_id, instance.save.call_args.kwargs['final_response_id'])

    @mock.patch('publish_astra.lock_is_held', return_value=False)
    def test_failed_respond_rejects_ready_response_from_other_owner(self, _lock_held):
        with tempfile.TemporaryDirectory() as temporary:
            instance, _snapshot = self.final_response_fixture(Path(temporary))

            def relay(command, *_arguments):
                if command == 'respond':
                    raise RuntimeError('transport result unknown')
                if command == 'show':
                    intent = checkpoint.load(instance.cont / 'final-response-intent.json')
                    return ('---\n'
                            'id: FIXED\n'
                            'status: READY\n'
                            'owner_instance: shadow\n'
                            'posted_by: mac\n'
                            'response_id: R-1111111111111111\n'
                            'response_outcome: success\n'
                            f'response_note: {intent["note"]}\n'
                            'responded_by: different-worker\n'
                            '---\n## Log\n')
                self.fail('Unexpected Relay command: ' + command)

            instance.relay = mock.Mock(side_effect=relay)
            with self.assertRaisesRegex(RuntimeError, 'canonical READY reconciliation failed'):
                instance.submit_fixed_final_response()
            intent = checkpoint.load(instance.cont / 'final-response-intent.json')
            self.assertEqual('prepared', intent['status'])
            self.assertIsNone(intent['response_id'])

    @mock.patch('publish_astra.lock_is_held', return_value=False)
    def test_final_snapshot_with_new_fallback_is_rejected_without_response(self, _lock_held):
        with tempfile.TemporaryDirectory() as temporary:
            instance, snapshot = self.final_response_fixture(Path(temporary))
            snapshot['new_fallback_ids'] = ['00000000001']
            with self.assertRaisesRegex(RuntimeError, 'not delivered before verification'):
                instance.submit_fixed_final_response()
            instance.relay.assert_not_called()
            self.assertFalse((instance.cont / 'final-response-intent.json').exists())


if __name__ == '__main__':
    unittest.main()
