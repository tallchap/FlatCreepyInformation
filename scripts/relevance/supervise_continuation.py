#!/usr/bin/env python3
"""Detached continuation owner with durable local/Relay pause and safe drain.

The private config and private ASR endpoints MUST live outside the continuation
directory. Relay author labels are an operational filter on a private repository,
not cryptographic identity. Neither the config nor a session wallet is uploaded.
"""
import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid


def now():
    return datetime.now(timezone.utc).isoformat()


def read(path, default=None):
    return json.loads(Path(path).read_text(encoding='utf-8-sig')) if Path(path).exists() else ({} if default is None else default)


def atomic(path, value):
    from audit import replace_with_retry
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        replace_with_retry(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def hidden():
    return {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}


def alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied is not proof of death.
        code = wintypes.DWORD()
        try:
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def parent_pid(pid):
    if os.name != 'nt':
        return int(Path(f'/proc/{pid}/stat').read_text().split(') ')[1].split()[1])
    result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
        f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').ParentProcessId"],
        capture_output=True, text=True, timeout=10, check=True, **hidden())
    return int(result.stdout.strip())


def decode_job(payload, job_id):
    expected = f'jobs/{job_id}.md'
    if payload.get('type') != 'file' or payload.get('path') != expected or payload.get('encoding') != 'base64':
        raise ValueError('Remote job content identity/encoding mismatch')
    raw = base64.b64decode(''.join(payload['content'].split()), validate=True)
    if len(raw) != payload.get('size') or hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest() != payload.get('sha'):
        raise ValueError('Remote job content size/blob digest mismatch')
    text = raw.decode('utf-8')
    match = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not match:
        raise ValueError('Malformed canonical Relay job')
    meta = dict(line.split(': ', 1) for line in match[1].splitlines() if ': ' in line)
    if meta.get('id') != job_id:
        raise ValueError('Remote job ID mismatch')
    return meta, match[2], payload['sha']


def remote_controls(body, authors):
    """Only exact log entries, never quoted/task-body mentions or substrings."""
    in_log, found = False, []
    for position, line in enumerate(body.splitlines()):
        if line == '## Log':
            in_log = True
            continue
        if line.startswith('## ') and in_log:
            break
        if not in_log:
            continue
        match = re.fullmatch(r'- (\S+)  (\S+)  SNIPPY_CONTROL (PAUSE|RESUME)', line)
        if not match or match[2] not in authors:
            continue
        datetime.fromisoformat(match[1].replace('Z', '+00:00'))
        found.append({'action': match[3], 'author': match[2], 'issued_at': match[1],
            'line_position': position, 'line_sha256': hashlib.sha256(line.encode()).hexdigest()})
    return found


def load_config(path):
    path = Path(path).resolve()
    config = read(path)
    required = {'root', 'continuation_dir', 'relay', 'job_id', 'private_env_file', 'whisper_python',
                'relay_session_file', 'instance', 'origin', 'ffmpeg', 'range_cache', 'runtime_commit'}
    if not required.issubset(config):
        raise ValueError('Private supervisor config missing keys: ' + ', '.join(sorted(required - set(config))))
    for key in ('root', 'continuation_dir', 'relay', 'private_env_file', 'whisper_python', 'relay_session_file', 'ffmpeg', 'range_cache'):
        config[key] = str(Path(config[key]).resolve())
    if config.get('checkpoint_dir'):
        config['checkpoint_dir'] = str(Path(config['checkpoint_dir']).resolve())
    continuation = Path(config['continuation_dir'])
    if path.is_relative_to(continuation):
        raise ValueError('Private supervisor config must be outside continuation output')
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9_-]{0,63}', config['job_id']):
        raise ValueError('Use the uppercase canonical job ID')
    for key in ('private_env_file', 'relay_session_file'):
        if Path(config[key]).is_relative_to(continuation) or not Path(config[key]).is_file():
            raise ValueError('Required private file missing or inside deliverable directory: ' + key)
    config['_config_path'] = str(path)
    return config


def submit_control(config, action, source='local', details=None, identifier=None):
    action = action.upper()
    if action not in ('PAUSE', 'RESUME'):
        raise ValueError('Unknown control action')
    continuation = Path(config['continuation_dir'])
    identifier = identifier or f'{time.time_ns():020d}-{uuid.uuid4().hex}'
    if not re.fullmatch(r'[A-Za-z0-9_-]+', identifier):
        raise ValueError('Invalid control request ID')
    request = {'schema_version': 'snippy-control-v1', 'id': identifier, 'job_id': config['job_id'],
               'action': action, 'source': source, 'received_at': now(), **(details or {})}
    path = continuation / 'control-requests' / (identifier + '.json')
    created = not path.exists()
    if created:
        atomic(path, request)
    # Local pause must work immediately, even when a supervisor is offline.
    if created and action == 'PAUSE' and source == 'local':
        atomic(Path(config['root']) / 'STOP.json', {'job_id': config['job_id'], 'time': now(),
            'reason': 'Explicit operator pause', 'control_request_id': identifier, 'source': source})
    return request


def control_order(item):
    issued = datetime.fromisoformat(item.get('issued_at', item['received_at']).replace('Z', '+00:00'))
    if issued.tzinfo is None:
        raise ValueError('Control timestamps must include a timezone')
    return [issued.astimezone(timezone.utc).isoformat(timespec='microseconds'),
            item.get('remote_sequence', -1), item['id']]


def stop_digest(root):
    path = Path(root) / 'STOP.json'
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def disk_capacity(root, range_cache, checkpoint_dir):
    """Measure each Windows volume once, report capacity at all workload paths."""
    volumes, paths = {}, {}
    for value in (root, range_cache, checkpoint_dir):
        path = Path(value).resolve()
        existing = path
        while not existing.exists() and existing.parent != existing:
            existing = existing.parent
        volume = existing.anchor.casefold() if os.name == 'nt' else str(existing)
        if volume not in volumes:
            volumes[volume] = shutil.disk_usage(existing).free
        paths[str(path)] = volumes[volume]
    return paths


class Supervisor:
    def __init__(self, config, self_test=False):
        self.config, self.self_test = config, self_test
        self.root, self.cont = Path(config['root']), Path(config['continuation_dir'])
        self.checkpoint_dir = Path(config.get('checkpoint_dir', self.cont.parent / 'checkpoints')).resolve()
        self.scripts = Path(__file__).resolve().parent
        self.cont.mkdir(parents=True, exist_ok=True)
        self.state_path = self.cont / 'status.json'
        self.state = read(self.state_path)
        self.state_lock = threading.RLock()
        self.exit = threading.Event()
        self.jobs = queue.Queue()
        self.pending_tasks = set()
        self.runner = self.server = None
        self.endpoint = None
        self.open_logs = []
        self.finished = False
        self.last_remote_success = time.monotonic()
        self.first_remote_success = threading.Event()
        self._coverage_cache, self._coverage_at = None, 0
        self.env = dict(os.environ, PYTHONUTF8='1', RELAY_SESSION_FILE=config['relay_session_file'],
            RELAY_SESSION_PINNED='1', RELAY_INSTANCE=config['instance'],
            RELAY_CAPS='shadow,windows,cuda,ffmpeg,codex',
            SNIPPY_WHISPER_PYTHON=config['whisper_python'], SNIPPY_STOP_FILE=str(self.root / 'STOP.json'),
            SNIPPY_ENCODER_PROFILE='nvenc_p4', SNIPPY_FFMPEG=config['ffmpeg'],
            SNIPPY_ORIGINAL_RANGE_CACHE=config['range_cache'])
        self.control = read(self.cont / 'control-state.json') or {
            'desired': 'running', 'processed_ids': [], 'transitions': [], 'initial_self_test': self_test}

    def save(self, **values):
        with self.state_lock:
            self.state.update(time=now(), supervisor_pid=os.getpid(), job_id=self.config['job_id'],
                              runtime_commit=self.config['runtime_commit'], **values)
            atomic(self.state_path, self.state)

    def control_save(self):
        atomic(self.cont / 'control-state.json', self.control)

    def enqueue(self, kind, data=None):
        with self.state_lock:
            if kind in ('checkpoint', 'finalize') and kind in self.pending_tasks:
                return
            self.pending_tasks.add(kind)
        self.jobs.put((kind, data))

    def relay(self, *arguments):
        result = subprocess.run([sys.executable, '-X', 'utf8', str(Path(self.config['relay']) / 'relay.py'),
            *arguments], cwd=self.config['relay'], env=self.env, capture_output=True, text=True,
            encoding='utf-8', timeout=900, **hidden())
        with (self.cont / 'relay-operations.log').open('a', encoding='utf-8') as output:
            output.write(now() + ' ' + ' '.join(arguments[:2]) + '\n' + result.stdout + result.stderr + '\n')
        if result.returncode:
            raise RuntimeError(f'Relay {arguments[0]} exited {result.returncode}; see relay-operations.log')
        return result.stdout

    def remote_reader(self):
        history_path = self.cont / 'remote-control-history.json'
        history = read(history_path).get('commands', [])
        while not self.exit.is_set():
            began = time.monotonic()
            try:
                command = ['gh', 'api', f"repos/tallchap/relay/contents/jobs/{self.config['job_id']}.md?ref=main"]
                result = subprocess.run(command, cwd=self.config['relay'], env=self.env, capture_output=True,
                    text=True, encoding='utf-8', timeout=20, check=True, **hidden())
                meta, body, blob = decode_job(json.loads(result.stdout), self.config['job_id'])
                if meta.get('posted_by') != self.config['origin'] or meta.get('owner_instance') != self.config['instance']:
                    raise ValueError('Relay origin/worker routing identity changed')
                if meta.get('status') != 'CLAIMED':
                    if not (self.state.get('phase') == 'finalizing' and meta.get('status') in ('READY', 'DONE')):
                        submit_control(self.config, 'PAUSE', 'relay_lifecycle', {'reason': 'Job no longer CLAIMED'})
                controls = remote_controls(body, {self.config['origin'], self.config['instance']})
                keys = [row['line_sha256'] for row in controls]
                if keys[:len(history)] != history:
                    raise ValueError('Processed Relay control history changed; refusing replay')
                for index in range(len(history), len(controls)):
                    item = controls[index]
                    # Deterministic identity makes crash recovery after enqueue idempotent.
                    identifier = f'remote-{index:08d}-{item["line_sha256"]}'
                    submit_control(self.config, item['action'], 'relay_log',
                        {**item, 'remote_sequence': index, 'relay_blob_sha': blob}, identifier)
                    history.append(keys[index])
                    atomic(history_path, {'commands': history, 'last_blob_sha': blob, 'time': now(),
                        'author_filter': 'Private repository author labels, not cryptographic origin identity'})
                self.save(last_remote_poll_at=now(), remote_poll_error=None, remote_blob_sha=blob,
                          remote_control_count=len(history))
                self.last_remote_success = time.monotonic()
                self.first_remote_success.set()
            except Exception as exc:
                self.save(remote_poll_error=f'{type(exc).__name__}: {exc}', remote_poll_failed_at=now())
                if isinstance(exc, ValueError):
                    submit_control(self.config, 'PAUSE', 'remote_control_integrity', {'reason': str(exc)})
            self.exit.wait(max(0.1, 30 - (time.monotonic() - began)))

    def checkpoint(self, final=False):
        from checkpoint_shadow import create_checkpoint
        result = subprocess.run([sys.executable, '-X', 'utf8', str(self.scripts / 'production_report.py'),
            '--root', str(self.root)], env=self.env, capture_output=True, text=True, timeout=300, **hidden())
        if result.returncode:
            raise RuntimeError('Production report failed: ' + result.stderr[-1000:])
        snapshot = create_checkpoint(self.root, self.checkpoint_dir)
        metadata = self.safe_metadata(Path(snapshot['directory']).with_name(Path(snapshot['directory']).name + '-continuation'))
        self.relay('send', self.config['job_id'], snapshot['directory'], str(metadata), '--kind', 'response', '--tag',
                   'continuation-' + str(snapshot['recorded_candidates']) + '-' + str(int(time.time())))
        self.save(last_checkpoint_at=now(), last_checkpoint_directory=snapshot['directory'],
                  last_checkpoint_covered=self.coverage()['covered'])
        return snapshot

    def safe_metadata(self, destination):
        from checkpoint_shadow import reject_secrets
        destination.mkdir(parents=True, exist_ok=False)
        names = ('authorization.json', 'preflight-reconciliation.json', 'continuation-plan.json',
            'continuation-status.json', 'status.json', 'control-state.json', 'remote-control-history.json',
            'admission-approved.json', 'final-verification.json', 'code-verification.json',
            'pause-self-test.json', 'preflight-reconciliation.md', 'CONTROL.md', 'control.ps1')
        paths = [self.cont / name for name in names]
        for name in ('drains', 'control-requests', 'stop-history', 'recovery-prior-records'):
            paths.extend((self.cont / name).glob('*.json'))
        for path in paths:
            if not path.is_file():
                continue
            if path.is_symlink() or not path.resolve().is_relative_to(self.cont.resolve()):
                raise ValueError('Unsafe continuation metadata path')
            data = read(path) if path.suffix == '.json' else path.read_text(encoding='utf-8-sig')
            reject_secrets(data)
            target = destination / path.relative_to(self.cont)
            if path.suffix == '.json':
                atomic(target, data)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(data, encoding='utf-8')
        return destination

    def background(self):
        while not self.exit.is_set():
            try:
                kind, data = self.jobs.get(timeout=1)
            except queue.Empty:
                continue
            try:
                if kind == 'log':
                    self.relay('log', self.config['job_id'], data)
                elif kind == 'checkpoint':
                    self.checkpoint()
                elif kind == 'finalize':
                    self.finalize()
                self.save(last_background_success_at=now(), background_error=None)
            except Exception as exc:
                self.save(background_error=f'{kind}: {type(exc).__name__}: {exc}')
                if kind == 'finalize':
                    submit_control(self.config, 'PAUSE', 'finalization_failure',
                        {'reason': 'Final verification/delivery failed; explicit investigation required'})
                    self.save(finalization_failed=True)
            finally:
                with self.state_lock:
                    self.pending_tasks.discard(kind)
                self.jobs.task_done()

    def coverage(self, force=False):
        if not force and self._coverage_cache and time.monotonic() - self._coverage_at < 5:
            return self._coverage_cache
        rows = [read(path) for path in (self.root / 'records').glob('*.json')]
        counts = dict(Counter(row.get('status', 'unknown') for row in rows))
        covered = sum(counts.get(key, 0) for key in ('published', 'already_published', 'awaiting_astra', 'failed'))
        self._coverage_cache = {'counts': counts, 'covered': covered, 'remaining': 1644 - covered, 'recorded': len(rows)}
        self._coverage_at = time.monotonic()
        return self._coverage_cache

    def pause(self, reason):
        self.control['desired'] = 'paused'
        self.control['pause_reason'] = reason
        self.control['resume_stop_sha256'] = None
        self.control_save()
        atomic(self.root / 'STOP.json', {'time': now(), 'job_id': self.config['job_id'], 'reason': reason})
        self.save(phase='draining', desired='paused', pause_reason=reason)

    def apply_controls(self):
        paths = list((self.cont / 'control-requests').glob('*.json'))
        requests = [read(path) for path in paths]
        requests.sort(key=control_order)
        for item in requests:
            if item['id'] in self.control['processed_ids']:
                continue
            if item.get('job_id') != self.config['job_id'] or item.get('action') not in ('PAUSE', 'RESUME'):
                raise ValueError('Invalid durable control request')
            action = item['action']
            order = control_order(item)
            if self.control.get('last_applied_order') and order < self.control['last_applied_order']:
                self.control['processed_ids'].append(item['id'])
                self.control['transitions'].append({**item, 'skipped_at': now(),
                    'skip_reason': 'Control predates a later already-applied command'})
                self.control_save()
                continue
            self.control['desired'] = 'paused' if action == 'PAUSE' else 'running'
            self.control['last_applied_order'] = order
            self.control['processed_ids'].append(item['id'])
            self.control['transitions'].append({**item, 'applied_at': now()})
            self.control_save()  # Desired state survives a crash before its physical effect.
            if action == 'PAUSE':
                self.pause('Explicit ' + item['source'] + ' pause ' + item['id'])
            else:
                self.control['resume_stop_sha256'] = stop_digest(self.root)
                self.control_save()
                self.save(desired='running', resume_requested_at=now())
            self.enqueue('log', f"Control {action} accepted ({item['source']}, id={item['id']}); "
                         f"supervisor PID={os.getpid()}; durable status={self.state_path}.")

    def admission_approved(self):
        gate = read(self.cont / 'admission-approved.json')
        return (gate.get('approved') is True and gate.get('job_id') == self.config['job_id']
                and gate.get('runtime_commit') == self.config['runtime_commit'])

    def log_file(self, name):
        stream = (self.cont / name).open('a', encoding='utf-8')
        self.open_logs.append(stream)
        return stream

    def start_asr(self):
        from production import runner_lock
        self.verify_runtime()
        # An OS lock, not a stale PID file, gates a second production writer.
        with runner_lock(self.root / 'runner.lock'):
            pass
        stop = self.root / 'STOP.json'
        if stop.exists():
            if self.state.get('cycle', 0) and self.control.get('resume_stop_sha256') != stop_digest(self.root):
                self.pause('Unacknowledged STOP marker requires a new explicit resume')
                return
            archive = self.cont / 'stop-history' / (str(time.time_ns()) + '.json')
            archive.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(stop, archive)
            stop.unlink()
        self.control['resume_stop_sha256'] = None
        self.control_save()
        cycle = self.state.get('cycle', 0) + 1
        private_base = Path(self.config['_config_path']).parent
        endpoint_path = private_base / f'private-asr-{self.config["job_id"]}-{cycle}-{uuid.uuid4().hex}.json'
        self.env['SNIPPY_WHISPER_SERVER_CONFIG'] = str(endpoint_path)
        self.server = subprocess.Popen([self.config['whisper_python'], '-X', 'utf8',
            str(self.scripts / 'whisper_cuda_server.py'), '--media-root', str(self.root), '--config',
            str(endpoint_path), '--stop-file', str(stop)], cwd=self.scripts.parent.parent, env=self.env,
            stdout=self.log_file(f'asr-{cycle}.log'), stderr=subprocess.STDOUT, **hidden())
        self.endpoint = endpoint_path
        self.asr_deadline = time.monotonic() + 60
        self.save(phase='asr_starting', cycle=cycle, asr_launcher_pid=self.server.pid, asr_pid=None,
                  runner_pid=None, asr_started_at=now(), desired='running')

    def asr_ready(self):
        if not self.endpoint.exists():
            if self.server.poll() is not None or time.monotonic() > self.asr_deadline:
                self.pause('Persistent CUDA startup failed; inspect ASR log')
            return False
        endpoint = read(self.endpoint)
        actual = endpoint.get('pid')
        if (type(actual) is not int or not alive(actual) or self.server.poll() is not None
                or endpoint.get('provider', {}).get('device') != 'cuda'
                or endpoint.get('provider', {}).get('model') != 'small.en'
                or endpoint.get('provider', {}).get('compute_type') != 'float32'
                or endpoint.get('host') != '127.0.0.1'
                or Path(endpoint.get('media_root', '')).resolve() != self.root.resolve()
                or (actual != self.server.pid and parent_pid(actual) != self.server.pid)):
            self.pause('Persistent CUDA process identity/device mismatch')
            return False
        self.save(phase='self_test_running' if not self.admission_approved() else 'ready', asr_pid=actual,
                  asr_ready_at=now(), asr_model_load_seconds=endpoint.get('model_load_seconds'))
        return True

    def start_runner(self):
        self.verify_runtime()
        command = [sys.executable, '-X', 'utf8', str(self.scripts / 'production.py'), '--root', str(self.root),
            '--private-env-file', self.config['private_env_file'], '--machine', 'Shadow',
            '--whisper-cli', str(self.scripts / 'whisper_cuda_client.py'), '--continuation-id', self.config['job_id'],
            '--continuation-authorization', str(self.cont / 'authorization.json'), '--batch-workers', '2']
        self.runner = subprocess.Popen(command, cwd=self.scripts.parent.parent, env=self.env,
            stdout=self.log_file(f'runner-{self.state["cycle"]}.log'), stderr=subprocess.STDOUT, **hidden())
        self.save(phase='running', runner_pid=self.runner.pid, runner_started_at=now(), admission_approved=True)
        self.enqueue('log', f"Continuation launched: supervisor PID={os.getpid()}, runner PID={self.runner.pid}, "
            f"CUDA PID={self.state['asr_pid']}, code={self.config['runtime_commit']}; status={self.state_path}; "
            "2 Luna groups, render cap2, ASR cap1; existing publications/Astra holds protected.")

    def drained(self):
        endpoint_pid = read(self.endpoint).get('pid') if self.endpoint and self.endpoint.exists() else None
        return ((self.runner is None or self.runner.poll() is not None)
                and (self.server is None or self.server.poll() is not None)
                and not alive(self.state.get('asr_pid')) and not alive(endpoint_pid))

    def verify_runtime(self):
        repo = self.scripts.parent.parent
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True,
                              timeout=15, check=True, **hidden()).stdout.strip()
        changes = subprocess.run(['git', 'status', '--porcelain'], cwd=repo, capture_output=True, text=True,
                                 timeout=15, check=True, **hidden()).stdout.strip()
        if head != self.config['runtime_commit'] or changes:
            raise RuntimeError('Pinned runtime commit/clean worktree gate failed; no child launched')

    def record_drain(self):
        evidence = {'time': now(), 'cycle': self.state.get('cycle'), 'runner_pid': self.state.get('runner_pid'),
            'runner_exit_code': self.runner.returncode if self.runner else None,
            'asr_pid': self.state.get('asr_pid'), 'asr_launcher_pid': self.state.get('asr_launcher_pid'),
            'asr_exit_code': self.server.returncode if self.server else None, 'own_children_alive': False,
            'stop_exists': (self.root / 'STOP.json').exists(), 'coverage': self.coverage()}
        atomic(self.cont / 'drains' / f'cycle-{self.state.get("cycle", 0):04d}.json', evidence)
        self.runner = self.server = None
        self.save(phase='paused', drained_at=now(), runner_pid=None, asr_pid=None, asr_launcher_pid=None,
                  own_children_alive=False, resource_check=evidence)
        self.enqueue('checkpoint')
        self.enqueue('log', f"PAUSED and drained: prior runner PID={evidence['runner_pid']}, "
            f"ASR PID={evidence['asr_pid']}; own compute children alive=false; "
            f"remaining={evidence['coverage']['remaining']}; STOP retained; status={self.state_path}. "
            "Only explicit SNIPPY_CONTROL RESUME or local resume restarts work.")

    def finalize(self):
        result = subprocess.run([sys.executable, '-X', 'utf8', str(self.scripts / 'continuation_verify.py'),
            '--root', str(self.root), '--continuation-dir', str(self.cont)], cwd=self.scripts.parent.parent,
            env=self.env, capture_output=True, text=True, encoding='utf-8', timeout=3600, **hidden())
        (self.cont / 'final-verifier.log').write_text(result.stdout + result.stderr, encoding='utf-8')
        if result.returncode:
            raise RuntimeError('Final continuation verification failed; no success response submitted')
        snapshot = self.checkpoint(final=True)
        # Allowlist files explicitly; endpoint/config/wallet can never enter this bundle.
        delivery = self.cont / 'final-delivery'
        delivery.mkdir(exist_ok=True)
        self.safe_metadata(delivery / ('continuation-evidence-' + uuid.uuid4().hex[:8]))
        names = ('authorization.json', 'continuation-plan.json', 'continuation-status.json', 'status.json',
                 'control-state.json', 'remote-control-history.json', 'final-verification.json', 'final-verification.md',
                 'final-dispositions.csv', 'code-verification.json', 'preflight-reconciliation.json',
                 'preflight-reconciliation.md', 'pause-self-test.json', 'CONTROL.md', 'control.ps1')
        for name in names:
            path = self.cont / name
            if path.is_file():
                shutil.copy2(path, delivery / name)
        raw = delivery / 'raw-responses'
        for base in (self.root / 'batches', self.root / 'mac-checkpoint' / 'batches'):
            for path in base.rglob('response.json'):
                target = raw / path.relative_to(self.root)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
        self.relay('respond', self.config['job_id'], snapshot['directory'], str(delivery), '--tag',
            'continuation-final', '--note', 'Remaining frozen queue disposed; final verifier passed. '
            'Astra holds/source failures remain skipped, compute children stopped; controls, publication '
            'receipts and raw Luna usage responses included. Consumer validation/ack required.')
        self.save(phase='response_ready', response_submitted_at=now(), own_children_alive=False)
        self.finished = True

    def run(self):
        from production import runner_lock
        with runner_lock(self.cont / 'supervisor.lock'):
            previous_pids = [self.state.get(key) for key in ('runner_pid', 'asr_pid', 'asr_launcher_pid')]
            if any(alive(pid) for pid in previous_pids):
                self.pause('Prior recorded compute PID still alive; orphan drain required before explicit resume')
                self.save(orphan_pids=[pid for pid in previous_pids if alive(pid)])
            self.save(phase='starting', desired=self.control['desired'], started_at=now(), self_test=self.self_test,
                      control_commands={'pause': 'SNIPPY_CONTROL PAUSE', 'resume': 'SNIPPY_CONTROL RESUME'})
            reader = threading.Thread(target=self.remote_reader, daemon=True)
            worker = threading.Thread(target=self.background, daemon=True)
            reader.start()
            worker.start()
            last_log, last_checkpoint = time.monotonic(), time.monotonic()
            last_coverage = self.coverage()['covered']
            try:
                while not self.finished:
                    self.apply_controls()
                    coverage = self.coverage()
                    capacity = disk_capacity(self.root, self.config['range_cache'], self.checkpoint_dir)
                    free = min(capacity.values())
                    runner_status = read(self.root / 'status.json')
                    runner_summary = {key: value for key, value in runner_status.items() if key not in ('covered_ids', 'records', 'responses')}
                    self.save(coverage=coverage, free_disk_bytes=free, free_disk_bytes_by_path=capacity, runner_status=runner_summary,
                              desired=self.control['desired'])
                    if free < 20 * 1024**3 and self.control['desired'] == 'running':
                        self.pause('Root/cache/checkpoint volume below 20 GiB free; explicit resume required after capacity recovery')
                        self.enqueue('log', f"PAUSING: disk free {free} bytes is below 20 GiB; explicit resume required "
                            f"after capacity recovery. No originals or hash-bound media deleted. Status={self.state_path}.")
                    if time.monotonic() - self.last_remote_success > 75 and self.control['desired'] == 'running':
                        self.pause('Remote control reads stale beyond 75 seconds; explicit resume required after recovery')
                        self.enqueue('log', f"PAUSING because remote control polling is stale beyond75s; "
                            f"automatic resume disabled; status={self.state_path}.")
                    if (self.control['desired'] == 'running' and self.server is not None
                            and (self.root / 'STOP.json').exists() and not self.state.get('production_completed')
                            and self.control.get('resume_stop_sha256') != stop_digest(self.root)):
                        self.pause('External STOP marker observed; explicit resume required after drain')
                    orphans = [pid for pid in self.state.get('orphan_pids', []) if alive(pid)]
                    if self.state.get('production_completed'):
                        if self.drained() and 'finalize' not in self.pending_tasks and not self.state.get('finalization_failed'):
                            self.save(phase='finalizing', own_children_alive=False)
                            self.enqueue('finalize')
                    elif orphans:
                        self.save(phase='orphan_draining', orphan_pids=orphans)
                    elif self.control['desired'] == 'paused' or (self.root / 'STOP.json').exists() and self.server is not None:
                        if self.server is None and self.runner is None:
                            self.save(phase='paused', own_children_alive=False)
                        elif self.drained():
                            self.record_drain()
                        else:
                            self.save(phase='draining')
                    elif self.server is None:
                        if not self.first_remote_success.is_set():
                            self.save(phase='waiting_for_initial_remote_control_read')
                        else:
                            # The reader writes requests before setting readiness.
                            # Re-read them here to close the first-poll/launch race.
                            self.apply_controls()
                            if self.control['desired'] == 'running':
                                self.start_asr()
                    elif self.state.get('phase') == 'asr_starting':
                        self.asr_ready()
                    elif self.server.poll() is not None:
                        self.pause('CUDA server exited unexpectedly; no automatic retry')
                    elif self.runner is None and self.admission_approved():
                        self.start_runner()
                    elif self.runner is not None and self.runner.poll() is not None:
                        status = read(self.root / 'status.json')
                        coverage = self.coverage(force=True)
                        complete = (self.runner.returncode == 0 and status.get('phase') == 'continuation_completed'
                                    and coverage['remaining'] == 0)
                        atomic(self.root / 'STOP.json', {'time': now(), 'job_id': self.config['job_id'],
                            'reason': 'Production completed; drain owned CUDA before final verification' if complete else 'Runner stopped'})
                        if complete:
                            self.save(phase='completion_draining', production_completed=True)
                        else:
                            self.pause(f"Runner exited {self.runner.returncode}, phase={status.get('phase')}; explicit investigation/resume required")
                    if time.monotonic() - last_log >= 180:
                        self.enqueue('log', f"Continuation {self.state.get('phase')}: coverage={coverage['covered']}/1644, "
                            f"remaining={coverage['remaining']}, counts={coverage['counts']}, supervisor PID={os.getpid()}, "
                            f"runner PID={self.state.get('runner_pid')}, CUDA PID={self.state.get('asr_pid')}; "
                            f"heartbeat={self.state['time']}; status={self.state_path}.")
                        last_log = time.monotonic()
                    if coverage['covered'] - last_coverage >= 25 or time.monotonic() - last_checkpoint >= 900:
                        self.enqueue('checkpoint')
                        last_coverage, last_checkpoint = coverage['covered'], time.monotonic()
                    self.exit.wait(1)
            except BaseException as exc:
                self.save(phase='supervisor_error', error=f'{type(exc).__name__}: {exc}',
                    own_children_alive=not self.drained(), automatic_restart=False)
                atomic(self.root / 'STOP.json', {'time': now(), 'job_id': self.config['job_id'],
                    'reason': 'Supervisor error; accepted operations drain, no new admissions'})
                try:
                    self.relay('log', self.config['job_id'], f"Supervisor error {type(exc).__name__}; "
                        f"STOP written, accepted calls draining; PID receipts preserved at {self.state_path}; no automatic retry.")
                except Exception:
                    pass
                raise
            finally:
                atomic(self.root / 'STOP.json', {'time': now(), 'job_id': self.config['job_id'],
                    'reason': 'Supervisor exited; no new admissions'})
                self.exit.set()
                for stream in self.open_logs:
                    stream.close()
        return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('action', choices=('run', 'pause', 'resume', 'status'), nargs='?', default='run')
    args = parser.parse_args(argv)
    config = load_config(args.config)
    if args.action == 'status':
        print(json.dumps(read(Path(config['continuation_dir']) / 'status.json'), indent=2))
        return 0
    if args.action in ('pause', 'resume'):
        print(json.dumps(submit_control(config, args.action), indent=2))
        return 0
    return Supervisor(config, args.self_test).run()


if __name__ == '__main__':
    raise SystemExit(main())
