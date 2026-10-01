"""Offline regressions for scoped batch-overlap tuning and maintenance drains."""
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import production as p
import supervise_continuation as control
import test_continuation


def sign(value):
    value = {key: item for key, item in value.items() if key != 'authorization_sha256'}
    value['authorization_sha256'] = p.audit.digest(value)
    return value


class BatchTuningTests(unittest.TestCase):
    # Borrow the frozen-continuation fixture without re-running its tests.
    setUp, record, runner = (test_continuation.ContinuationTests.setUp, test_continuation.ContinuationTests.record,
                             test_continuation.ContinuationTests.runner)

    def tuning(self, plan_sha, **changes):
        path = self.auth.parent / 'batch-tuning-authorization.json'
        value = {'schema_version': 'snippy-batch-tuning-v1', 'tuning_job_id': 'SNIPPY-SPEED-TRIALS-20261001-A',
                 'continuation_id': self.job, 'continuation_plan_sha256': plan_sha, 'maximum_batch_workers': 6,
                 'maximum_batch_members': 5, 'render_slots': 2, 'asr_slots': 1,
                 'control_path': str(self.auth.parent / 'batch-workers.json')}
        value.update(changes)
        p.audit.atomic(path, sign(value))
        return path

    def frozen_plan_sha(self):
        return self.runner().continuation_plan()['plan_sha256']

    def test_more_than_two_continuation_workers_requires_tuning_authorization(self):
        with self.assertRaises(ValueError):
            p.Runner(self.root, 'whisper', batch_workers=4, continuation_id=self.job, continuation_authorization=self.auth)

    def test_hash_bound_authorization_bound_to_frozen_plan_allows_four(self):
        path = self.tuning(self.frozen_plan_sha())
        runner = p.Runner(
            self.root, 'whisper', batch_workers=4, continuation_id=self.job, continuation_authorization=self.auth,
            tuning_authorization=path)
        plan = runner.continuation_plan()
        self.assertEqual(4, runner.batch_workers)
        self.assertEqual(2, plan['maximum_batch_workers'])  # Frozen plan itself is never rewritten.

    def test_authorization_for_another_plan_fails_closed(self):
        self.frozen_plan_sha()
        path = self.tuning('0' * 64)
        runner = p.Runner(self.root, 'whisper', batch_workers=4, continuation_id=self.job,
                          continuation_authorization=self.auth, tuning_authorization=path)
        with self.assertRaisesRegex(ValueError, 'different continuation plan'):
            runner.continuation_plan()

    def test_self_hash_mismatch_overcap_or_changed_local_caps_are_rejected(self):
        sha = self.frozen_plan_sha()
        for changes in ({'maximum_batch_workers': 7}, {'render_slots': 3}, {'asr_slots': 2},
                        {'maximum_batch_members': 6}, {'continuation_id': 'OTHER-JOB'},
                        {'control_path': str(self.root / 'elsewhere.json')}):
            path = self.tuning(sha, **changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                p.load_batch_tuning(path, self.job)
        path = self.tuning(sha)
        tampered = p.luna.read(path)
        tampered['maximum_batch_workers'] = 5
        p.audit.atomic(path, tampered)
        with self.assertRaisesRegex(ValueError, 'self-hash mismatch'):
            p.load_batch_tuning(path, self.job)

    def test_tuning_requires_continuation(self):
        path = self.tuning('0' * 64)
        with self.assertRaises(ValueError):
            p.Runner(self.root, 'whisper', batch_workers=4, tuning_authorization=path)

    def test_live_target_reads_control_clamps_and_reports_invalid(self):
        path = self.tuning(self.frozen_plan_sha())
        runner = p.Runner(self.root, 'whisper', batch_workers=2, continuation_id=self.job,
                          continuation_authorization=self.auth, tuning_authorization=path)
        runner.continuation_plan()
        control_path = self.auth.parent / 'batch-workers.json'
        self.assertEqual(2, runner.target_batch_workers())
        p.audit.atomic(control_path, {'continuation_id': self.job, 'batch_workers': 6})
        self.assertEqual(6, runner.target_batch_workers())
        p.audit.atomic(control_path, {'continuation_id': self.job, 'batch_workers': 9})
        self.assertEqual(2, runner.target_batch_workers())
        self.assertIn('Invalid batch worker control', runner.batch_workers_error)
        p.audit.atomic(control_path, {'continuation_id': 'OTHER', 'batch_workers': 4})
        self.assertEqual(2, runner.target_batch_workers())
        p.audit.atomic(control_path, {'continuation_id': self.job, 'batch_workers': 4})
        self.assertEqual(4, runner.target_batch_workers())
        self.assertIsNone(runner.batch_workers_error)
        applied = (self.auth.parent / 'batch-workers-applied.jsonl').read_text().splitlines()
        self.assertEqual(3, len(applied))  # 2->6, 6->2 (invalid), 2->4; repeated invalid is not re-logged.
        runner.heartbeat()
        status = p.luna.read(self.root / 'status.json')
        self.assertEqual((4, 2, 6), (status['batch_workers'], status['batch_workers_startup'],
                                     status['batch_workers_authorized_max']))

    def test_scheduler_follows_live_target_without_exceeding_it(self):
        path = self.tuning(self.frozen_plan_sha())
        runner = p.Runner(self.root, 'whisper', batch_workers=2, continuation_id=self.job,
                          continuation_authorization=self.auth, tuning_authorization=path)
        runner.continuation_plan()
        control_path = self.auth.parent / 'batch-workers.json'
        release, lock = threading.Event(), threading.Lock()
        live = {'now': 0, 'peak': 0, 'calls': 0}

        def fake(batch, slot):
            with lock:
                live['now'] += 1
                live['calls'] += 1
                live['peak'] = max(live['peak'], live['now'])
            release.wait(10)
            with lock:
                live['now'] -= 1
            return True

        slots = [(self.root / 'batches' / f'b{i}', [{'candidate_id': f'x{i}'}]) for i in range(8)]
        with patch.object(runner, 'batch_slots', return_value=iter(slots)), \
                patch.object(runner, 'process_batch', side_effect=fake), \
                patch.object(runner, 'stop_requested', return_value=False):
            thread = threading.Thread(target=runner.run_batches)
            thread.start()
            time.sleep(.5)
            self.assertEqual(2, live['now'])
            p.audit.atomic(control_path, {'continuation_id': self.job, 'batch_workers': 4})
            deadline = time.monotonic() + 8
            while live['now'] < 4 and time.monotonic() < deadline:
                time.sleep(.1)
            self.assertEqual(4, live['now'])  # Raised without waiting for a batch to finish.
            release.set()
            thread.join(15)
        self.assertFalse(thread.is_alive())
        self.assertEqual(8, live['calls'])
        self.assertLessEqual(live['peak'], 4)


class MaintenanceControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root, self.cont = self.base / 'run', self.base / 'continuation'
        (self.root / 'records').mkdir(parents=True)
        self.cont.mkdir()
        for name in ('private.env', 'wallet.json'):
            (self.base / name).write_text('{}')
        self.config = dict(root=str(self.root), continuation_dir=str(self.cont), relay=str(self.base),
            job_id='TEST-20261001', private_env_file=str(self.base / 'private.env'),
            whisper_python='python', relay_session_file=str(self.base / 'wallet.json'), instance='shadow',
            origin='mac', ffmpeg='ffmpeg', range_cache=str(self.base / 'cache'), runtime_commit='a' * 40)

    def drained(self, request, remote_after=True, remote_count=0):
        applied = {**request, 'applied_at': control.now()}
        control.atomic(self.cont / 'control-state.json', {'desired': 'paused', 'processed_ids': [request['id']],
            'transitions': [applied], 'last_applied_order': control.control_order(request)})
        control.atomic(self.cont / 'status.json', {'phase': 'paused', 'own_children_alive': False,
            'last_remote_poll_at': control.now() if remote_after else '0001-01-01T00:00:00+00:00',
            'remote_poll_error': None, 'remote_blob_sha': 'blob-before-resume',
            'remote_control_count': remote_count})

    def fresh_remote_poll(self):
        state = control.read(self.cont / 'status.json')
        state.update(last_remote_poll_at=control.now(), remote_poll_error=None,
                     remote_blob_sha='blob-after-resume')
        control.atomic(self.cont / 'status.json', state)

    def test_maintenance_pause_writes_stop_immediately(self):
        control.submit_control(self.config, 'PAUSE', 'maintenance', {'reason': 'tuning'})
        self.assertTrue((self.root / 'STOP.json').exists())

    def test_maintenance_resume_only_after_its_own_applied_drained_pause(self):
        request = control.submit_control(self.config, 'PAUSE', 'maintenance', {'reason': 'tuning'})
        self.assertIn('not been applied', control.maintenance_resume_blocker(self.config))
        self.drained(request, remote_after=False)
        self.assertIn('remote-control read', control.maintenance_resume_blocker(self.config))
        self.drained(request)
        self.assertIsNone(control.maintenance_resume_blocker(self.config))

    def test_newer_user_pause_is_never_auto_resumed(self):
        request = control.submit_control(self.config, 'PAUSE', 'maintenance', {'reason': 'tuning'})
        self.drained(request)
        time.sleep(.01)
        control.submit_control(self.config, 'PAUSE', 'relay_log', {'issued_at': control.now()})
        self.assertIn('relay_log PAUSE', control.maintenance_resume_blocker(self.config))
        self.assertEqual(2, control.main(['--config', str(self.write_config()), 'maintenance-resume']))

    def test_user_pause_alone_blocks_maintenance_resume(self):
        request = control.submit_control(self.config, 'PAUSE', 'local')
        self.drained(request)
        self.assertIn('local PAUSE', control.maintenance_resume_blocker(self.config))

    def test_maintenance_drain_cannot_replace_an_applied_user_pause(self):
        for source in ('local', 'relay_log'):
            with self.subTest(source=source):
                user = control.submit_control(self.config, 'PAUSE', source)
                maintenance = control.submit_control(self.config, 'PAUSE', 'maintenance')
                self.drained(maintenance)
                state = control.read(self.cont / 'control-state.json')
                requests = [control.read(p) for p in (self.cont / 'control-requests').glob('*.json')]
                state['processed_ids'] = [item['id'] for item in requests]
                state['transitions'] = [{**item, 'applied_at': control.now()}
                                        for item in sorted(requests, key=control.control_order)]
                control.atomic(self.cont / 'control-state.json', state)
                resume, blocker = control.submit_maintenance_resume(self.config, 'screen')
                self.assertIsNone(resume)
                self.assertIn('explicit user RESUME', blocker)
                self.assertEqual('paused', control.read(self.cont / 'control-state.json')['desired'])
                self.assertFalse(any(control.read(path)['action'] == 'RESUME'
                                     for path in (self.cont / 'control-requests').glob('*.json')))

    def test_explicit_user_resume_allows_later_maintenance_resume(self):
        user_pause = control.submit_control(self.config, 'PAUSE', 'local')
        user_resume = control.submit_control(self.config, 'RESUME', 'relay_log')
        maintenance = control.submit_control(self.config, 'PAUSE', 'maintenance')
        self.drained(maintenance)
        state = control.read(self.cont / 'control-state.json')
        state['processed_ids'] = [user_pause['id'], user_resume['id'], maintenance['id']]
        state['transitions'] = [{**item, 'applied_at': control.now()}
                                for item in (user_pause, user_resume, maintenance)]
        control.atomic(self.cont / 'control-state.json', state)
        resume, blocker = control.submit_maintenance_resume(self.config, 'screen')
        self.assertIsNone(blocker)
        self.assertIsNotNone(resume)
        supervisor = control.Supervisor(self.config)
        with patch.object(supervisor, 'refresh_remote_controls', side_effect=self.fresh_remote_poll):
            supervisor.apply_controls()
        self.assertEqual('running', supervisor.control['desired'])

    def test_supervisor_rejects_user_pause_injected_during_cli_resume(self):
        request = control.submit_control(self.config, 'PAUSE', 'maintenance', {'reason': 'tuning'})
        self.drained(request)
        path = self.write_config()
        original = control._submit_control_unlocked

        def inject(config, action, *args, **kwargs):
            if action.upper() == 'RESUME':
                original(config, 'PAUSE', 'local', {'reason': 'user interleaving'})
            return original(config, action, *args, **kwargs)

        with patch.object(control, '_submit_control_unlocked', side_effect=inject):
            self.assertEqual(0, control.main(['--config', str(path), 'maintenance-resume']))
        supervisor = control.Supervisor(control.load_config(path))
        with patch.object(supervisor, 'refresh_remote_controls', side_effect=self.fresh_remote_poll):
            supervisor.apply_controls()
        self.assertEqual('paused', supervisor.control['desired'])
        resume = next(row for row in supervisor.control['transitions'] if row['action'] == 'RESUME')
        self.assertIn('blocked_at', resume)
        self.assertIn('local PAUSE', resume['block_reason'])

    def test_supervisor_requires_remote_poll_after_resume_request(self):
        pause = control.submit_control(self.config, 'PAUSE', 'maintenance', {'reason': 'tuning'})
        self.drained(pause)
        time.sleep(.01)
        resume, blocker = control.submit_maintenance_resume(self.config, 'screen')
        self.assertIsNone(blocker)
        supervisor = control.Supervisor(self.config)
        with patch.object(supervisor, 'refresh_remote_controls', return_value=('unchanged', 0)):
            supervisor.apply_controls()
        self.assertEqual('paused', supervisor.control['desired'])
        transition = next(row for row in supervisor.control['transitions'] if row['id'] == resume['id'])
        self.assertIn('remote-control read after the maintenance resume request', transition['block_reason'])

    def test_unchanged_board_resume_applies_after_fresh_supervisor_poll(self):
        pause = control.submit_control(self.config, 'PAUSE', 'maintenance', {'reason': 'tuning'})
        self.drained(pause, remote_count=3)
        time.sleep(.01)
        resume, blocker = control.submit_maintenance_resume(self.config, 'screen')
        self.assertIsNone(blocker)
        supervisor = control.Supervisor(self.config)
        with patch.object(supervisor, 'refresh_remote_controls', side_effect=self.fresh_remote_poll) as refresh:
            supervisor.apply_controls()
        refresh.assert_called_once()
        self.assertEqual('running', supervisor.control['desired'])
        transition = next(row for row in supervisor.control['transitions'] if row['id'] == resume['id'])
        self.assertIn('applied_at', transition)
        self.assertEqual(pause['id'], transition['expected_maintenance_pause_id'])

    def test_delayed_remote_pause_beyond_resume_fence_still_pauses(self):
        pause = control.submit_control(self.config, 'PAUSE', 'maintenance', {'reason': 'tuning'})
        self.drained(pause, remote_count=4)
        time.sleep(.01)
        resume, blocker = control.submit_maintenance_resume(self.config, 'screen')
        self.assertIsNone(blocker)
        supervisor = control.Supervisor(self.config)
        with patch.object(supervisor, 'refresh_remote_controls', side_effect=self.fresh_remote_poll):
            supervisor.apply_controls()
        self.assertEqual('running', supervisor.control['desired'])
        control.submit_control(self.config, 'PAUSE', 'relay_log',
            {'issued_at': '2026-10-01T00:00:00Z', 'remote_sequence': 4}, 'delayed-remote-pause')
        supervisor.apply_controls()
        self.assertEqual('paused', supervisor.control['desired'])
        self.assertTrue(supervisor.control['transitions'][-1]['late_remote_pause_after_maintenance_resume'])

    def test_forced_refresh_materializes_pending_remote_pause_and_blocks_resume(self):
        pause = control.submit_control(self.config, 'PAUSE', 'maintenance', {'reason': 'tuning'})
        self.drained(pause)
        time.sleep(.01)
        resume, blocker = control.submit_maintenance_resume(self.config, 'screen')
        self.assertIsNone(blocker)
        supervisor = control.Supervisor(self.config)

        def refresh():
            control.submit_control(self.config, 'PAUSE', 'relay_log',
                {'issued_at': '2026-10-01T00:00:00Z', 'remote_sequence': 0}, 'pending-board-pause')
            self.fresh_remote_poll()
            return 'new-blob', 1

        with patch.object(supervisor, 'refresh_remote_controls', side_effect=refresh):
            supervisor.apply_controls()
        self.assertEqual('paused', supervisor.control['desired'])
        transition = next(row for row in supervisor.control['transitions'] if row['id'] == resume['id'])
        self.assertIn('blocked_at', transition)

    def write_config(self, **extra):
        path = self.base / 'private-config.json'
        control.atomic(path, {**self.config, **extra})
        return path

    def test_more_than_two_workers_requires_authorization_in_config(self):
        with self.assertRaises(ValueError):
            control.load_config(self.write_config(batch_workers=4))
        with self.assertRaises(ValueError):
            control.load_config(self.write_config(batch_workers=7, tuning_authorization=str(self.base / 'private.env')))

    def test_runner_command_carries_configured_workers_and_authorization(self):
        auth = self.cont / 'batch-tuning-authorization.json'
        control.atomic(auth, {'maximum_batch_workers': 6, 'tuning_job_id': 'T', 'control_path': str(self.cont / 'batch-workers.json')})
        config = control.load_config(self.write_config(batch_workers=4, tuning_authorization=str(auth)))
        supervisor = control.Supervisor(config)
        supervisor.state['cycle'] = 1
        supervisor.state['asr_pid'] = 1
        with patch.object(supervisor, 'verify_runtime'), patch.object(control.subprocess, 'Popen') as launch, \
                patch.object(supervisor, 'enqueue'):
            launch.return_value.pid = 4242
            supervisor.start_runner()
        for stream in supervisor.open_logs:
            stream.close()
        command = launch.call_args[0][0]
        self.assertEqual('4', command[command.index('--batch-workers') + 1])
        self.assertEqual(str(auth.resolve()), command[command.index('--tuning-authorization') + 1])
        entry = control.write_batch_workers(config, 6, 'screen')
        self.assertEqual(6, control.read(self.cont / 'batch-workers.json')['batch_workers'])
        self.assertEqual(entry['tuning_job_id'], 'T')
        with self.assertRaises(ValueError):
            control.write_batch_workers(config, 7, 'too many')

    def test_default_config_keeps_two_workers_and_no_authorization(self):
        config = control.load_config(self.write_config())
        supervisor = control.Supervisor(config)
        supervisor.state.update(cycle=1, asr_pid=1)
        with patch.object(supervisor, 'verify_runtime'), patch.object(control.subprocess, 'Popen') as launch, \
                patch.object(supervisor, 'enqueue'):
            launch.return_value.pid = 4242
            supervisor.start_runner()
        for stream in supervisor.open_logs:
            stream.close()
        command = launch.call_args[0][0]
        self.assertEqual('2', command[command.index('--batch-workers') + 1])
        self.assertNotIn('--tuning-authorization', command)


if __name__ == '__main__':
    unittest.main()
