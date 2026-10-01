"""No network/paid work: control ordering, durable pause, lifecycle regressions."""
import base64
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import supervise_continuation as module


class Process:
    def __init__(self, result=None, pid=99999998):
        self.returncode, self.pid = result, pid

    def poll(self):
        return self.returncode


class Tests(unittest.TestCase):
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
            origin='mac', ffmpeg='ffmpeg', range_cache=str(self.base / 'cache'), runtime_commit='a' * 40,
            _config_path=str(self.base / 'private-config.json'))

    def supervisor(self):
        return module.Supervisor(self.config, self_test=True)

    def once(self, supervisor):
        def wait(_):
            supervisor.finished = True
        supervisor.exit.wait = wait
        with patch.object(module.threading.Thread, 'start'), patch.object(module, 'alive', return_value=False), \
                patch.object(supervisor, 'verify_runtime'), patch.object(supervisor, 'relay'), \
                patch.object(module.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 100 * 1024**3})()):
            supervisor.run()

    def test_only_exact_log_controls_and_allowed_authors(self):
        body = ('Task says SNIPPY_CONTROL PAUSE\n- 2026-10-01T00:00:00Z  mac  SNIPPY_CONTROL PAUSE\n'
                '## Log\n- 2026-10-01T00:01:00Z  mac  SNIPPY_CONTROL PAUSE\n'
                '- 2026-10-01T00:01:01Z  alien  SNIPPY_CONTROL RESUME\n'
                '- 2026-10-01T00:01:02Z  shadow  quoted SNIPPY_CONTROL RESUME\n'
                '- 2026-10-01T00:01:03Z  mac  SNIPPY_CONTROL RESUME\n'
                '## Other\n- 2026-10-01T00:01:04Z  mac  SNIPPY_CONTROL PAUSE\n')
        self.assertEqual(['PAUSE', 'RESUME'], [r['action'] for r in module.remote_controls(body, {'mac', 'shadow'})])

    def test_remote_contents_identity_size_and_blob_hash(self):
        raw = b'---\nid: TEST-20261001\nstatus: CLAIMED\n---\n## Log\n'
        payload = dict(type='file', path='jobs/TEST-20261001.md', encoding='base64', size=len(raw),
            content=base64.b64encode(raw).decode(), sha=hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest())
        self.assertEqual('CLAIMED', module.decode_job(payload, 'TEST-20261001')[0]['status'])
        for key, bad in [('path', 'jobs/OTHER.md'), ('size', 1), ('sha', '0' * 40)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                module.decode_job({**payload, key: bad}, 'TEST-20261001')

    def test_local_pause_is_immediate_and_resume_does_not_clear_stop(self):
        module.submit_control(self.config, 'pause', identifier='first')
        stop = (self.root / 'STOP.json').read_bytes()
        module.submit_control(self.config, 'resume', identifier='second')
        self.assertEqual(stop, (self.root / 'STOP.json').read_bytes())

    def test_duplicate_pause_request_does_not_rewrite_stop(self):
        module.submit_control(self.config, 'pause', identifier='one')
        (self.root / 'STOP.json').unlink()
        module.submit_control(self.config, 'pause', identifier='one')
        self.assertFalse((self.root / 'STOP.json').exists())

    def test_delayed_remote_pause_does_not_override_later_local_resume(self):
        supervisor = self.supervisor()
        module.submit_control(self.config, 'resume', identifier='later',
            details={'issued_at': '2026-10-01T00:02:00Z'})
        supervisor.apply_controls()
        module.submit_control(self.config, 'pause', source='relay_log', identifier='earlier',
            details={'issued_at': '2026-10-01T00:01:00Z', 'remote_sequence': 0})
        self.assertFalse((self.root / 'STOP.json').exists())
        supervisor.apply_controls()
        self.assertEqual('running', supervisor.control['desired'])
        self.assertIn('skip_reason', supervisor.control['transitions'][-1])

    def test_controls_are_ordered_and_idempotent(self):
        supervisor = self.supervisor()
        module.submit_control(self.config, 'resume', source='relay_log', identifier='resume',
            details={'issued_at': '2026-10-01T00:01:00Z', 'remote_sequence': 1})
        module.submit_control(self.config, 'pause', source='relay_log', identifier='pause',
            details={'issued_at': '2026-10-01T00:01:00Z', 'remote_sequence': 0})
        supervisor.apply_controls()
        self.assertEqual(['PAUSE', 'RESUME'], [r['action'] for r in supervisor.control['transitions']])
        self.assertEqual('running', supervisor.control['desired'])
        supervisor.apply_controls()
        self.assertEqual(2, len(supervisor.control['transitions']))
        self.assertTrue((self.root / 'STOP.json').exists())  # Removed only after actual drain.

    def test_external_stop_becomes_durable_pause(self):
        supervisor = self.supervisor()
        supervisor.server, supervisor.runner = Process(), Process()
        supervisor.state.update(cycle=1)
        module.atomic(self.root / 'STOP.json', {'reason': 'external operator'})
        with patch.object(supervisor, 'start_asr') as launch:
            self.once(supervisor)
        self.assertEqual('paused', supervisor.control['desired'])
        self.assertEqual('draining', supervisor.state['phase'])
        launch.assert_not_called()

    def test_stale_remote_control_reads_pause_without_auto_resume(self):
        supervisor = self.supervisor()
        supervisor.last_remote_success = time.monotonic() - 80
        with patch.object(supervisor, 'start_asr') as launch:
            self.once(supervisor)
        self.assertEqual('paused', supervisor.control['desired'])
        self.assertIn('stale', supervisor.control['pause_reason'])
        launch.assert_not_called()

    def test_drained_redirector_is_not_proof_actual_gpu_child_stopped(self):
        supervisor = self.supervisor()
        supervisor.server = Process(0)
        supervisor.endpoint = self.base / 'endpoint.json'
        module.atomic(supervisor.endpoint, {'pid': 12345})
        with patch.object(module, 'alive', side_effect=lambda pid: pid == 12345):
            self.assertFalse(supervisor.drained())
        with patch.object(module, 'alive', return_value=False):
            self.assertTrue(supervisor.drained())

    def test_admission_requires_exact_job_and_commit(self):
        supervisor = self.supervisor()
        self.assertFalse(supervisor.admission_approved())
        module.atomic(self.cont / 'admission-approved.json', {'approved': True, 'job_id': self.config['job_id'],
            'runtime_commit': 'wrong'})
        self.assertFalse(supervisor.admission_approved())
        module.atomic(self.cont / 'admission-approved.json', {'approved': True, 'job_id': self.config['job_id'],
            'runtime_commit': self.config['runtime_commit']})
        self.assertTrue(supervisor.admission_approved())

    def test_complete_state_never_restarts_gpu_during_finalization(self):
        supervisor = self.supervisor()
        supervisor.state.update(production_completed=True)
        with patch.object(supervisor, 'start_asr') as launch:
            self.once(supervisor)
        launch.assert_not_called()
        self.assertEqual('finalizing', supervisor.state['phase'])
        self.assertIn('finalize', supervisor.pending_tasks)

    def test_unacknowledged_stop_is_not_removed_on_resume_spawn(self):
        supervisor = self.supervisor()
        supervisor.state.update(cycle=1)
        module.atomic(self.root / 'STOP.json', {'reason': 'new pause'})
        with patch.object(supervisor, 'verify_runtime'), patch.object(module.subprocess, 'Popen') as launch:
            supervisor.start_asr()
        launch.assert_not_called()
        self.assertEqual('paused', supervisor.control['desired'])
        self.assertTrue((self.root / 'STOP.json').exists())

    def test_runtime_gate_rejects_dirty_or_wrong_commit(self):
        supervisor = self.supervisor()
        good = type('Result', (), {'stdout': self.config['runtime_commit']})()
        dirty = type('Result', (), {'stdout': ' M source.py'})()
        with patch.object(module.subprocess, 'run', side_effect=[good, dirty]), self.assertRaises(RuntimeError):
            supervisor.verify_runtime()

    def test_private_config_inside_delivery_directory_is_rejected(self):
        path = self.cont / 'config.json'
        module.atomic(path, self.config)
        with self.assertRaises(ValueError):
            module.load_config(path)

    def test_actual_current_process_is_alive(self):
        self.assertTrue(module.alive(module.os.getpid()))

    def test_no_compute_before_successful_initial_remote_read(self):
        supervisor = self.supervisor()
        with patch.object(supervisor, 'start_asr') as launch:
            self.once(supervisor)
        launch.assert_not_called()
        self.assertEqual('waiting_for_initial_remote_control_read', supervisor.state['phase'])

    def test_first_remote_pause_is_applied_before_any_compute(self):
        supervisor = self.supervisor()
        supervisor.first_remote_success.set()
        original = supervisor.apply_controls
        calls = []
        def apply():
            calls.append(1)
            # First loop scan precedes reader delivery; the launch-boundary
            # scan must observe the already-successful reader's request.
            if len(calls) == 2:
                module.submit_control(self.config, 'PAUSE', source='relay_log', identifier='first-remote-pause')
            original()
        with patch.object(supervisor, 'apply_controls', side_effect=apply), patch.object(supervisor, 'start_asr') as launch:
            self.once(supervisor)
        launch.assert_not_called()
        self.assertEqual('paused', supervisor.control['desired'])

    def test_optional_checkpoint_directory_and_all_storage_paths_reported(self):
        target = self.base / 'separate-checkpoints'
        supervisor = module.Supervisor({**self.config, 'checkpoint_dir': str(target)})
        self.assertEqual(target.resolve(), supervisor.checkpoint_dir)
        with patch.object(module.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 99})()) as usage:
            capacity = module.disk_capacity(self.root, self.base / 'cache', target)
        self.assertEqual(3, len(capacity))
        self.assertEqual({99}, set(capacity.values()))
        if module.os.name == 'nt':
            self.assertEqual(1, usage.call_count)

    @unittest.skipUnless(module.os.name == 'nt', 'Windows separate-volume capacity guard')
    def test_low_cache_or_checkpoint_volume_pauses_even_when_media_volume_has_space(self):
        supervisor = self.supervisor()
        supervisor.checkpoint_dir = Path('D:/continuation/checkpoints')
        capacity = {str(self.root): 100 * 1024**3, str(supervisor.checkpoint_dir): 19 * 1024**3}
        with patch.object(module, 'disk_capacity', return_value=capacity), patch.object(supervisor, 'start_asr') as launch:
            self.once(supervisor)
        launch.assert_not_called()
        self.assertEqual('paused', supervisor.control['desired'])
        self.assertIn('checkpoint volume', supervisor.control['pause_reason'])
        self.assertEqual(capacity, supervisor.state['free_disk_bytes_by_path'])


if __name__ == '__main__':
    unittest.main()
