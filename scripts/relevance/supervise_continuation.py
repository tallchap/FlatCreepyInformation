#!/usr/bin/env python3
"""Detached continuation owner with durable local/Relay pause and safe drain.

The private config and private ASR endpoints MUST live outside the continuation
directory. Relay author labels are an operational filter on a private repository,
not cryptographic identity. Neither the config nor a session wallet is uploaded.
"""
import argparse
import base64
from collections import Counter
from contextlib import contextmanager
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


_CONTROL_THREAD_LOCK = threading.RLock()
REMOTE_READ_TIMEOUT_SECONDS = 30
REMOTE_STALE_SECONDS = 90
FIXED_SUBSET_EXPECTED_COUNT = 340
FINAL_RESPONSE_INTENT_SCHEMA = 'snippy-fixed-subset-final-response-intent-v1'


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


def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def object_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def hidden():
    return {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}


@contextmanager
def control_lock(continuation):
    """Serialize durable control creation and application across processes."""
    path = Path(continuation) / '.control.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with _CONTROL_THREAD_LOCK, path.open('a+b') as handle:
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


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


def parse_relay_show(text, job_id):
    """Parse the canonical `relay show` frontmatter used for reconciliation."""
    match = re.match(r'^---\n(.*?)\n---\n', text, re.S)
    if not match:
        raise ValueError('Malformed canonical Relay show output')
    meta = {}
    for line in match.group(1).splitlines():
        if ':' not in line:
            continue
        key, value = (part.strip() for part in line.split(':', 1))
        if value.startswith('"') and value.endswith('"'):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        meta[key] = None if value == 'null' else value
    if meta.get('id') != job_id:
        raise ValueError('Canonical Relay show returned a different job')
    return meta


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
    workers = config.setdefault('batch_workers', 2)
    if type(workers) is not int or not 1 <= workers <= 6:
        raise ValueError('batch_workers must be an integer from 1 to 6')
    if config.get('tuning_authorization'):
        config['tuning_authorization'] = str(Path(config['tuning_authorization']).resolve())
        if not Path(config['tuning_authorization']).is_file():
            raise ValueError('Configured batch tuning authorization is missing')
    elif workers > 2:
        raise ValueError('More than two batch workers requires an explicit tuning authorization')
    config['_config_path'] = str(path)
    return config


def _submit_control_unlocked(config, action, source='local', details=None, identifier=None):
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
    if created and action == 'PAUSE' and source in ('local', 'maintenance'):
        atomic(Path(config['root']) / 'STOP.json', {'job_id': config['job_id'], 'time': now(),
            'reason': 'Explicit operator pause', 'control_request_id': identifier, 'source': source})
    return request


def submit_control(config, action, source='local', details=None, identifier=None):
    with control_lock(config['continuation_dir']):
        return _submit_control_unlocked(config, action, source, details, identifier)


def control_state_generation(control):
    payload = json.dumps(control, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()


def parse_timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Control timestamps must include a timezone')
    return parsed.astimezone(timezone.utc)


def _maintenance_resume_snapshot_unlocked(config, resume_request=None):
    """Return (blocker, proof) for a CLI or supervisor maintenance resume.

    Maintenance may resume only its own drain: the newest control request of
    any source must be an applied maintenance PAUSE, and a fresh remote-control
    read must postdate the resume request at application time. The proof binds
    the request to the exact applied pause/control generation observed by the
    CLI; the supervisor revalidates it under the same cross-process lock.
    """
    continuation = Path(config['continuation_dir'])
    requests = [read(path) for path in (continuation / 'control-requests').glob('*.json')]
    if resume_request:
        requests = [item for item in requests if item.get('id') != resume_request.get('id')]
    requests.sort(key=control_order)
    state = read(continuation / 'status.json')
    control = read(continuation / 'control-state.json')
    if not requests:
        return 'No control request exists', None
    latest = requests[-1]
    if latest.get('action') != 'PAUSE' or latest.get('source') != 'maintenance':
        return f"Newest control is {latest.get('source')} {latest.get('action')}, not this maintenance pause", None
    # A later maintenance drain cannot grant permission to undo a user pause.
    # Preserve explicit user intent independently of the maintenance ordering.
    explicit = next((item for item in reversed(requests)
                     if item.get('source') in ('local', 'relay_log')), None)
    if explicit and explicit.get('action') == 'PAUSE':
        return f"Prior {explicit['source']} PAUSE requires an explicit user RESUME", None
    if resume_request:
        required = {'expected_maintenance_pause_id', 'expected_maintenance_pause_order',
                    'expected_control_state_sha256', 'observed_remote_poll_at',
                    'observed_remote_blob_sha', 'observed_remote_control_count'}
        missing = sorted(required - set(resume_request))
        if missing:
            return 'Maintenance resume proof is incomplete: ' + ', '.join(missing), None
        if latest['id'] != resume_request['expected_maintenance_pause_id']:
            return 'Maintenance resume is not bound to the newest maintenance pause', None
        if control_order(latest) != resume_request['expected_maintenance_pause_order']:
            return 'Maintenance pause order changed after resume authorization', None
        if control_state_generation(control) != resume_request['expected_control_state_sha256']:
            return 'Control state changed after maintenance resume authorization', None
        observed_count = resume_request['observed_remote_control_count']
        if type(observed_count) is not int or state.get('remote_control_count', -1) < observed_count:
            return 'Remote-control history regressed after maintenance resume authorization', None
    if latest['id'] not in control.get('processed_ids', []) or control.get('desired') != 'paused':
        return 'Maintenance pause has not been applied by a supervisor yet', None
    unprocessed = [item['id'] for item in requests if item['id'] not in control.get('processed_ids', [])]
    if unprocessed:
        return 'A control request arrived after the maintenance resume snapshot: ' + ', '.join(unprocessed), None
    if control.get('last_applied_order') != control_order(latest):
        return 'Maintenance pause is not the last applied control generation', None
    if state.get('phase') != 'paused' or state.get('own_children_alive') is not False:
        return 'Supervisor has not reported a drained pause', None
    remote_poll_at = state.get('last_remote_poll_at')
    remote_blob = state.get('remote_blob_sha')
    remote_count = state.get('remote_control_count')
    freshness_floor = resume_request['received_at'] if resume_request else latest['received_at']
    try:
        fresh = remote_poll_at and parse_timestamp(remote_poll_at) > parse_timestamp(freshness_floor)
    except (TypeError, ValueError):
        fresh = False
    if state.get('remote_poll_error') or not fresh:
        return ('No successful remote-control read after the maintenance resume request'
                if resume_request else 'No successful remote-control read after the maintenance pause'), None
    if not isinstance(remote_blob, str) or not remote_blob or type(remote_count) is not int:
        return 'Remote-control read lacks a bound blob/count receipt', None
    proof = {
        'expected_maintenance_pause_id': latest['id'],
        'expected_maintenance_pause_order': control_order(latest),
        'expected_control_state_sha256': control_state_generation(control),
        'observed_remote_poll_at': remote_poll_at,
        'observed_remote_blob_sha': remote_blob,
        'observed_remote_control_count': remote_count,
    }
    return None, proof


def maintenance_resume_blocker(config):
    with control_lock(config['continuation_dir']):
        return _maintenance_resume_snapshot_unlocked(config)[0]


def submit_maintenance_resume(config, reason):
    """Atomically validate and enqueue a proof-bound maintenance resume."""
    with control_lock(config['continuation_dir']):
        blocker, proof = _maintenance_resume_snapshot_unlocked(config)
        if blocker:
            return None, blocker
        request = _submit_control_unlocked(config, 'RESUME', 'maintenance',
            {'reason': reason, **proof})
        return request, None


def write_batch_workers(config, value, reason):
    """Set the live whole-batch overlap target inside the authorized cap."""
    authorization = config.get('tuning_authorization')
    if not authorization:
        raise ValueError('No batch tuning authorization configured')
    tuning = read(authorization)
    if type(value) is not int or not 1 <= value <= tuning['maximum_batch_workers']:
        raise ValueError('Batch workers outside the authorized cap')
    path = Path(tuning['control_path'])
    previous = read(path)
    entry = {'continuation_id': config['job_id'], 'batch_workers': value, 'set_at': now(), 'reason': reason,
             'tuning_job_id': tuning['tuning_job_id'], 'previous': previous.get('batch_workers')}
    atomic(path, entry)
    with (path.parent / 'batch-workers-requests.jsonl').open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(entry) + '\n')
    return entry


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
        self.pending_final_response = None
        self.reader_thread = self.worker_thread = None
        self.background_threads_quiesced = False
        self.remote_lock = threading.Lock()
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
        self.scope = self.validate_scope_authority()
        self.authorized_ids = self.scope.get('authorized_candidate_ids')
        self.owner_record = None

    def validate_scope_authority(self):
        """Re-read the immutable fixed-subset authority at admission/resume gates."""
        auth_path = (self.cont / 'authorization.json').resolve()
        plan_path = (self.cont / 'continuation-plan.json').resolve()
        if not auth_path.exists() and not plan_path.exists():
            return {'scope': None}
        if not auth_path.exists() or not plan_path.exists():
            raise ValueError('Continuation authorization and plan must either both exist or both be absent')
        auth, plan = read(auth_path), read(plan_path)
        if auth.get('scope') != 'fixed_subset_frozen_manifest':
            return {'scope': auth.get('scope'), 'authorization_file_sha256': file_sha256(auth_path),
                    'continuation_plan_file_sha256': file_sha256(plan_path)}
        auth_unsigned = {key: value for key, value in auth.items() if key != 'authorization_sha256'}
        plan_unsigned = {key: value for key, value in plan.items() if key != 'plan_sha256'}
        selected_name = auth.get('selected_ids_file')
        if (auth.get('schema_version') != 'snippy-fixed-subset-authorization-v1'
                or auth.get('job_id') != self.config['job_id']
                or auth.get('authorization_sha256') != object_digest(auth_unsigned)
                or not isinstance(selected_name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', selected_name)):
            raise ValueError('Fixed-subset supervisor authorization identity/self-hash failed')
        selected_path = (self.cont / selected_name).resolve()
        if not selected_path.is_relative_to(self.cont.resolve()):
            raise ValueError('Selected ID file escapes continuation directory')
        raw = selected_path.read_bytes()
        if (not raw or raw.startswith(b'\xef\xbb\xbf') or b'\r' in raw or not raw.endswith(b'\n')
                or file_sha256(selected_path) != auth.get('selected_ids_sha256')):
            raise ValueError('Selected ID bytes/hash are invalid')
        try:
            ids = raw[:-1].decode('ascii').split('\n')
        except UnicodeDecodeError as exc:
            raise ValueError('Selected IDs must be ASCII') from exc
        manifest_path, cull_path = self.root / 'input/manifest.json', self.root / 'input/culled-ids.json'
        if (len(ids) != len(set(ids)) or len(ids) != auth.get('candidate_count')
                or len(ids) != FIXED_SUBSET_EXPECTED_COUNT
                or any(not re.fullmatch(r'[A-Za-z0-9_-]{11}', vid) for vid in ids)
                or auth.get('manifest_sha256') != file_sha256(manifest_path)
                or auth.get('original_manifest_sha256') != file_sha256(manifest_path)
                or auth.get('culled_ids_sha256') != file_sha256(cull_path)
                or plan.get('schema_version') != 'snippy-fixed-subset-plan-v1'
                or plan.get('continuation_id') != self.config['job_id']
                or plan.get('plan_sha256') != object_digest(plan_unsigned)
                or plan.get('authorization_sha256') != file_sha256(auth_path)
                or plan.get('authorized_candidate_ids') != ids
                or plan.get('authorized_candidate_count') != len(ids)
                or plan.get('selected_ids_sha256') != auth.get('selected_ids_sha256')
                or plan.get('manifest_sha256') != auth.get('manifest_sha256')
                or plan.get('culled_ids_sha256') != auth.get('culled_ids_sha256')):
            raise ValueError('Fixed-subset supervisor scope/plan binding failed')
        return {'scope': auth['scope'], 'authorization_file_sha256': file_sha256(auth_path),
                'authorization_sha256': auth['authorization_sha256'],
                'continuation_plan_file_sha256': file_sha256(plan_path),
                'continuation_plan_sha256': plan['plan_sha256'],
                'selected_ids_sha256': auth['selected_ids_sha256'],
                'manifest_sha256': auth['manifest_sha256'], 'culled_ids_sha256': auth['culled_ids_sha256'],
                'authorized_candidate_ids': ids}

    def write_owner_record(self):
        """Publish the identity of the process holding the root-global owner lock."""
        self.scope = self.validate_scope_authority()
        if self.scope.get('scope') != 'fixed_subset_frozen_manifest':
            return None
        record = {'schema_version': 'snippy-production-owner-v1', 'job_id': self.config['job_id'],
                  'pid': os.getpid(), 'runtime_commit': self.config['runtime_commit'],
                  'continuation_authorization': {'path': str((self.cont / 'authorization.json').resolve()),
                                                 'sha256': self.scope['authorization_file_sha256']},
                  'continuation_plan': {'path': str((self.cont / 'continuation-plan.json').resolve()),
                                        'sha256': self.scope['continuation_plan_file_sha256']},
                  'selected_ids_sha256': self.scope['selected_ids_sha256'],
                  'manifest_sha256': self.scope['manifest_sha256'],
                  'culled_ids_sha256': self.scope['culled_ids_sha256'],
                  'lock_path': str((self.root / 'production-owner.lock').resolve()),
                  'created_at': now(), 'active': True}
        record['owner_record_sha256'] = object_digest(record)
        atomic(self.root / 'production-owner.json', record)
        atomic(self.cont / 'production-owner.json', record)
        self.owner_record = record
        return record

    def save(self, **values):
        with self.state_lock:
            self.state.update(time=now(), supervisor_pid=os.getpid(), job_id=self.config['job_id'],
                              runtime_commit=self.config['runtime_commit'], **values)
            atomic(self.state_path, self.state)

    def control_save(self):
        atomic(self.cont / 'control-state.json', self.control)

    def enqueue(self, kind, data=None):
        with self.state_lock:
            if self.finished:
                return False
            if kind in ('checkpoint', 'finalize') and kind in self.pending_tasks:
                return False
            self.pending_tasks.add(kind)
        self.jobs.put((kind, data))
        return True

    def relay(self, *arguments):
        command = [sys.executable, '-X', 'utf8', str(Path(self.config['relay']) / 'relay.py'), *arguments]
        safe_conflict = ('response upload was not attached because the board changed '
                         '(board main advanced from the transaction snapshot); retry from fresh state')
        for attempt in range(1, 4):
            result = subprocess.run(command, cwd=self.config['relay'], env=self.env, capture_output=True,
                text=True, encoding='utf-8', timeout=900, **hidden())
            with (self.cont / 'relay-operations.log').open('a', encoding='utf-8') as output:
                output.write(now() + ' ' + ' '.join(arguments[:2]) + f' attempt={attempt}\n'
                             + result.stdout + result.stderr + '\n')
            if not result.returncode:
                return result.stdout
            lines = (result.stdout + '\n' + result.stderr).splitlines()
            if arguments[0] == 'send' and safe_conflict in lines and attempt < 3:
                # The board explicitly rejected attachment, not the verified
                # upload. Identical paths/tag let Relay reuse the same bundle.
                continue
            raise RuntimeError(f'Relay {arguments[0]} exited {result.returncode}; see relay-operations.log')

    def refresh_remote_controls(self):
        """Perform one serialized, receipted read of canonical remote controls."""
        with self.remote_lock:
            history_path = self.cont / 'remote-control-history.json'
            history = read(history_path).get('commands', [])
            command = ['gh', 'api', f"repos/tallchap/relay/contents/jobs/{self.config['job_id']}.md?ref=main"]
            result = subprocess.run(command, cwd=self.config['relay'], env=self.env, capture_output=True,
                text=True, encoding='utf-8', timeout=REMOTE_READ_TIMEOUT_SECONDS, check=True, **hidden())
            if self.exit.is_set():
                return None
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
            return blob, len(history)

    def record_remote_failure(self, exc):
        self.save(remote_poll_error=f'{type(exc).__name__}: {exc}', remote_poll_failed_at=now())
        if isinstance(exc, ValueError):
            submit_control(self.config, 'PAUSE', 'remote_control_integrity', {'reason': str(exc)})

    def remote_reader(self):
        while not self.exit.is_set():
            began = time.monotonic()
            try:
                self.refresh_remote_controls()
            except Exception as exc:
                if not self.exit.is_set():
                    self.record_remote_failure(exc)
            self.exit.wait(max(0.1, 30 - (time.monotonic() - began)))

    def checkpoint(self, final=False):
        if self.scope.get('scope') == 'fixed_subset_frozen_manifest':
            from fixed_subset_checkpoint import create_checkpoint, mark_delivered
            snapshot = create_checkpoint(self.root, self.cont, self.checkpoint_dir,
                ffmpeg=self.config.get('ffmpeg'), final=final)
            # The final bundle is attached by `respond`, so sending it first
            # would duplicate bytes and falsely mark fallbacks delivered before
            # the terminal response is accepted.
            if not final:
                tag = ('fixed-subset-' + str(snapshot['recorded_candidates']) + '-'
                       + snapshot['manifest_sha256'][:12])
                self.relay('send', self.config['job_id'], snapshot['directory'], '--kind', 'response',
                           '--tag', tag)
                mark_delivered(self.cont, snapshot)
                self.save(last_checkpoint_at=now(), last_checkpoint_directory=snapshot['directory'],
                          last_checkpoint_covered=self.coverage()['covered'],
                          last_checkpoint_manifest_sha256=snapshot['manifest_file_sha256'],
                          last_checkpoint_new_fallback_ids=snapshot['new_fallback_ids'])
            return snapshot
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
            'pause-self-test.json', 'preflight-reconciliation.md', 'CONTROL.md', 'control.ps1',
            'batch-tuning-authorization.json', 'batch-workers.json', 'production-owner.json')
        paths = [self.cont / name for name in names]
        for name in ('drains', 'control-requests', 'stop-history', 'recovery-prior-records', 'admission-history'):
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
            if self.finished:
                with self.state_lock:
                    self.pending_tasks.discard(kind)
                self.jobs.task_done()
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

    def quiesce_background_threads(self):
        """Stop and join control/delivery threads before releasing owner locks."""
        self.exit.set()
        deadline = time.monotonic() + REMOTE_READ_TIMEOUT_SECONDS + 5
        threads = [thread for thread in (self.reader_thread, self.worker_thread) if thread is not None]
        for thread in threads:
            if thread is threading.current_thread() or not thread.is_alive():
                continue
            thread.join(max(0, deadline - time.monotonic()))
        alive_threads = [thread.name for thread in threads if thread.is_alive()]
        self.background_threads_quiesced = not alive_threads
        self.save(background_threads_quiesced=self.background_threads_quiesced,
                  background_threads_alive=alive_threads)
        if alive_threads:
            raise RuntimeError('Background threads did not quiesce before owner release: '
                               + ', '.join(alive_threads))

    def coverage(self, force=False):
        if not force and self._coverage_cache and time.monotonic() - self._coverage_at < 5:
            return self._coverage_cache
        if self.authorized_ids is not None:
            rows = [read(self.root / 'records' / f'{vid}.json')
                    if (self.root / 'records' / f'{vid}.json').exists()
                    else {'candidate_id': vid, 'status': 'unadmitted'} for vid in self.authorized_ids]
            if self.scope.get('scope') == 'fixed_subset_frozen_manifest':
                from production import validate_preflight_hold_receipt
                plan = read(self.cont / 'continuation-plan.json')
                preflight = validate_preflight_hold_receipt(
                    self.root, self.cont, plan, required=False)
                rows = [{**row, 'source_record_status': row.get('status'),
                         'status': preflight[row['candidate_id']]['effective_status']}
                        if row['candidate_id'] in preflight else row for row in rows]
            requested = len(self.authorized_ids)
        else:
            rows = [read(path) for path in (self.root / 'records').glob('*.json')]
            requested = 1644
        counts = dict(Counter(row.get('status', 'unknown') for row in rows))
        covered = sum(counts.get(key, 0) for key in ('published', 'already_published', 'awaiting_astra', 'failed'))
        self._coverage_cache = {'counts': counts, 'covered': covered, 'remaining': requested - covered,
                                'recorded': sum(row.get('status') != 'unadmitted' for row in rows),
                                'requested': requested}
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
        with control_lock(self.cont):
            pending_maintenance = {
                item['id'] for item in (read(path) for path in (self.cont / 'control-requests').glob('*.json'))
                if item.get('action') == 'RESUME' and item.get('source') == 'maintenance'
                and item.get('id') not in self.control['processed_ids']}
        remote_error = None
        if pending_maintenance:
            try:
                # A CLI snapshot is not enough: fetch the canonical board after
                # this resume request exists, then rescan under the control lock.
                self.refresh_remote_controls()
            except Exception as exc:
                self.record_remote_failure(exc)
                remote_error = f'Fresh remote-control read failed: {type(exc).__name__}: {exc}'
        with control_lock(self.cont):
            requests = [read(path) for path in (self.cont / 'control-requests').glob('*.json')]
            requests.sort(key=control_order)
            for item in requests:
                if item['id'] in self.control['processed_ids']:
                    continue
                if item.get('job_id') != self.config['job_id'] or item.get('action') not in ('PAUSE', 'RESUME'):
                    raise ValueError('Invalid durable control request')
                action = item['action']
                if action == 'RESUME':
                    self.validate_scope_authority()
                if action == 'RESUME' and item.get('source') == 'maintenance':
                    blocker = ('Maintenance resume arrived after the remote-refresh window; retry it'
                               if item['id'] not in pending_maintenance else remote_error)
                    if not blocker:
                        blocker = _maintenance_resume_snapshot_unlocked(self.config, item)[0]
                    if blocker:
                        self.control['processed_ids'].append(item['id'])
                        self.control['transitions'].append({**item, 'blocked_at': now(), 'block_reason': blocker})
                        self.control_save()
                        self.save(desired=self.control['desired'], maintenance_resume_blocked_at=now(),
                                  maintenance_resume_blocker=blocker)
                        self.enqueue('log', f"Maintenance RESUME rejected (id={item['id']}): {blocker}; "
                                     f"supervisor PID={os.getpid()}; production remains {self.control['desired']}.")
                        continue
                order = control_order(item)
                delayed_remote_pause = False
                if self.control.get('last_applied_order') and order < self.control['last_applied_order']:
                    last_applied = next((row for row in reversed(self.control['transitions'])
                                         if row.get('applied_at')), {})
                    fence = last_applied.get('observed_remote_control_count')
                    delayed_remote_pause = (
                        action == 'PAUSE' and item.get('source') == 'relay_log'
                        and last_applied.get('action') == 'RESUME'
                        and last_applied.get('source') == 'maintenance'
                        and type(item.get('remote_sequence')) is int and type(fence) is int
                        and item['remote_sequence'] >= fence)
                    if not delayed_remote_pause:
                        self.control['processed_ids'].append(item['id'])
                        self.control['transitions'].append({**item, 'skipped_at': now(),
                            'skip_reason': 'Control predates a later already-applied command'})
                        self.control_save()
                        continue
                self.control['desired'] = 'paused' if action == 'PAUSE' else 'running'
                if not delayed_remote_pause:
                    self.control['last_applied_order'] = order
                self.control['processed_ids'].append(item['id'])
                transition = {**item, 'applied_at': now()}
                if delayed_remote_pause:
                    transition['late_remote_pause_after_maintenance_resume'] = True
                self.control['transitions'].append(transition)
                self.control_save()  # Desired state survives a crash before its physical effect.
                if action == 'PAUSE':
                    self.pause('Explicit ' + item['source'] + ' pause ' + item['id'])
                else:
                    retrying_finalization = bool(self.state.get('finalization_failed'))
                    self.control['resume_stop_sha256'] = stop_digest(self.root)
                    self.control_save()
                    self.save(desired='running', resume_requested_at=now(),
                              finalization_failed=False if retrying_finalization else self.state.get(
                                  'finalization_failed', False),
                              finalization_retry_requested_at=now() if retrying_finalization else self.state.get(
                                  'finalization_retry_requested_at'),
                              finalization_retry_control_id=item['id'] if retrying_finalization else self.state.get(
                                  'finalization_retry_control_id'))
                self.enqueue('log', f"Control {action} accepted ({item['source']}, id={item['id']}); "
                             f"supervisor PID={os.getpid()}; durable status={self.state_path}.")

    def admission_approved(self):
        self.scope = self.validate_scope_authority()
        gate = read(self.cont / 'admission-approved.json')
        approved = (gate.get('approved') is True and gate.get('job_id') == self.config['job_id']
                    and gate.get('runtime_commit') == self.config['runtime_commit'])
        if self.scope.get('scope') == 'fixed_subset_frozen_manifest':
            approved = approved and all(gate.get(key) == self.scope[key] for key in (
                'authorization_file_sha256', 'authorization_sha256', 'continuation_plan_file_sha256',
                'continuation_plan_sha256', 'selected_ids_sha256', 'manifest_sha256', 'culled_ids_sha256'))
        return approved

    def log_file(self, name):
        stream = (self.cont / name).open('a', encoding='utf-8')
        self.open_logs.append(stream)
        return stream

    def pending_control_ids(self):
        return [item['id'] for item in
                (read(path) for path in (self.cont / 'control-requests').glob('*.json'))
                if item.get('id') not in self.control['processed_ids']]

    def start_asr(self):
        from production import runner_lock
        self.verify_runtime()
        self.validate_scope_authority()
        # An OS lock, not a stale PID file, gates a second production writer.
        with runner_lock(self.root / 'runner.lock'):
            pass
        with control_lock(self.cont):
            pending = self.pending_control_ids()
            if pending or self.control.get('desired') != 'running':
                self.save(phase='waiting_for_control_application', desired=self.control.get('desired'),
                          pending_control_ids=pending)
                return
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
                      runner_pid=None, asr_started_at=now(), desired='running', own_children_alive=True)

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
                  asr_ready_at=now(), asr_model_load_seconds=endpoint.get('model_load_seconds'), own_children_alive=True)
        return True

    def start_runner(self):
        self.verify_runtime()
        self.validate_scope_authority()
        command = [sys.executable, '-X', 'utf8', str(self.scripts / 'production.py'), '--root', str(self.root),
            '--private-env-file', self.config['private_env_file'], '--machine', 'Shadow',
            '--whisper-cli', str(self.scripts / 'whisper_cuda_client.py'), '--continuation-id', self.config['job_id'],
            '--continuation-authorization', str(self.cont / 'authorization.json'),
            '--batch-workers', str(self.config.get('batch_workers', 2))]
        if self.config.get('tuning_authorization'):
            command += ['--tuning-authorization', self.config['tuning_authorization']]
        with control_lock(self.cont):
            pending = self.pending_control_ids()
            if pending or self.control.get('desired') != 'running' or (self.root / 'STOP.json').exists():
                self.save(phase='waiting_for_control_application', desired=self.control.get('desired'),
                          pending_control_ids=pending)
                return
            self.runner = subprocess.Popen(command, cwd=self.scripts.parent.parent, env=self.env,
                stdout=self.log_file(f'runner-{self.state["cycle"]}.log'), stderr=subprocess.STDOUT, **hidden())
            self.save(phase='running', runner_pid=self.runner.pid, runner_started_at=now(), admission_approved=True,
                      own_children_alive=True)
        self.enqueue('log', f"Continuation launched: supervisor PID={os.getpid()}, runner PID={self.runner.pid}, "
            f"CUDA PID={self.state['asr_pid']}, code={self.config['runtime_commit']}; status={self.state_path}; "
            f"{self.config.get('batch_workers', 2)} Luna groups at start"
            + (" (live tuning control, authorized cap in batch-tuning-authorization.json)" if self.config.get('tuning_authorization') else '')
            + ", render cap2, ASR cap1; existing publications/Astra holds protected.")

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
        fixed_scope = self.scope.get('scope') == 'fixed_subset_frozen_manifest'
        prefinal = None
        if fixed_scope:
            # Deliver every still-new fallback while the owner is alive, then
            # make that immutable receipt a prerequisite of final verification.
            # The terminal response itself is deliberately deferred until the
            # root owner lock has been released below.
            prefinal = self.checkpoint(final=False)
        verifier = 'fixed_subset_verify.py' if fixed_scope else 'continuation_verify.py'
        result = subprocess.run([sys.executable, '-X', 'utf8', str(self.scripts / verifier),
            '--root', str(self.root), '--continuation-dir', str(self.cont)], cwd=self.scripts.parent.parent,
            env=self.env, capture_output=True, text=True, encoding='utf-8', timeout=3600, **hidden())
        (self.cont / 'final-verifier.log').write_text(result.stdout + result.stderr, encoding='utf-8')
        if result.returncode:
            raise RuntimeError('Final continuation verification failed; no success response submitted')
        if fixed_scope:
            self.pending_final_response = {
                'prefinal_checkpoint_directory': prefinal['directory'],
                'prefinal_checkpoint_manifest_sha256': prefinal['manifest_file_sha256'],
                'final_verification_file_sha256': file_sha256(self.cont / 'final-verification.json'),
            }
            self.save(phase='final_response_prepared', final_response_prepared_at=now(),
                      own_children_alive=False, **self.pending_final_response)
            with self.state_lock:
                self.finished = True
            self.exit.set()
            return
        snapshot = self.checkpoint(final=True)
        # Allowlist files explicitly; endpoint/config/wallet can never enter this bundle.
        delivery = self.cont / 'final-delivery'
        delivery.mkdir(exist_ok=True)
        self.safe_metadata(delivery / ('continuation-evidence-' + uuid.uuid4().hex[:8]))
        names = ('authorization.json', 'continuation-plan.json', 'continuation-status.json', 'status.json',
                 'control-state.json', 'remote-control-history.json', 'final-verification.json', 'final-verification.md',
                 'final-dispositions.csv', 'code-verification.json', 'preflight-reconciliation.json',
                 'preflight-reconciliation.md', 'pause-self-test.json', 'CONTROL.md', 'control.ps1',
                 'production-owner.json')
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

    def load_final_response_intent(self):
        path = self.cont / 'final-response-intent.json'
        if not path.is_file():
            return None
        intent = read(path)
        unsigned = {key: value for key, value in intent.items() if key != 'intent_sha256'}
        snapshot = Path(intent.get('snapshot_directory', '')).resolve()
        release = Path(intent.get('release_directory', '')).resolve()
        checkpoint_root = self.checkpoint_dir.resolve()
        response_id = intent.get('response_id')
        if (intent.get('schema_version') != FINAL_RESPONSE_INTENT_SCHEMA
                or intent.get('job_id') != self.config['job_id']
                or intent.get('owner_instance') != self.config['instance']
                or intent.get('intent_sha256') != object_digest(unsigned)
                or intent.get('status') not in ('prepared', 'accepted')
                or (intent.get('status') == 'accepted'
                    and not re.fullmatch(r'R-[0-9a-f]{16}', str(response_id or '')))
                or not snapshot.is_dir() or not snapshot.is_relative_to(checkpoint_root)
                or not release.is_dir() or not release.is_relative_to(checkpoint_root)
                or file_sha256(snapshot / 'checkpoint-manifest.json')
                    != intent.get('snapshot_manifest_file_sha256')
                or file_sha256(release / 'release-manifest.json')
                    != intent.get('release_manifest_file_sha256')
                or intent.get('snapshot_new_fallback_ids') != []):
            raise RuntimeError('Durable final response intent is invalid or stale')
        return intent

    def save_final_response_intent(self, intent):
        value = {key: item for key, item in intent.items() if key != 'intent_sha256'}
        value['intent_sha256'] = object_digest(value)
        atomic(self.cont / 'final-response-intent.json', value)
        return value

    def canonical_ready_response(self, intent):
        meta = parse_relay_show(self.relay('show', self.config['job_id']), self.config['job_id'])
        if meta.get('status') == 'CLAIMED':
            return None
        response_id = meta.get('response_id')
        if (meta.get('status') != 'READY'
                or meta.get('posted_by') != self.config['origin']
                or meta.get('owner_instance') != self.config['instance']
                or meta.get('responded_by') != self.config['instance']
                or meta.get('response_outcome') != 'success'
                or meta.get('response_note') != intent['note']
                or not re.fullmatch(r'R-[0-9a-f]{16}', str(response_id or ''))
                or intent.get('response_id') not in (None, response_id)):
            raise RuntimeError('Canonical Relay state does not match this final response intent')
        return meta

    def accept_final_response_intent(self, intent, response_id, reconciled=False):
        updated = {**intent, 'status': 'accepted', 'response_id': response_id,
                   'accepted_at': now(), 'accepted_via_reconciliation': bool(reconciled)}
        return self.save_final_response_intent(updated)

    def submit_fixed_final_response(self):
        """Respond only after all production locks are free and owner is inactive."""
        from publish_astra import lock_is_held

        if not self.pending_final_response or not self.drained():
            raise RuntimeError('Fixed-subset final response attempted before durable drain')
        if (not self.background_threads_quiesced
                or any(thread is not None and thread.is_alive()
                       for thread in (self.reader_thread, self.worker_thread))):
            raise RuntimeError('Fixed-subset final response attempted before background-thread quiescence')
        self.scope = self.validate_scope_authority()
        stop_path = self.root / 'STOP.json'
        root_owner_path = self.root / 'production-owner.json'
        continuation_owner_path = self.cont / 'production-owner.json'
        owner_lock = self.root / 'production-owner.lock'
        publication_lock = self.root / 'publication.lock'
        supervisor_lock = self.cont / 'supervisor.lock'
        if not stop_path.is_file() or not root_owner_path.is_file() or not continuation_owner_path.is_file():
            raise RuntimeError('Final release evidence is incomplete')
        owner_raw = root_owner_path.read_bytes()
        owner = read(root_owner_path)
        owner_unsigned = {key: value for key, value in owner.items() if key != 'owner_record_sha256'}
        expected_authority = {'path': str((self.cont / 'authorization.json').resolve()),
                              'sha256': self.scope['authorization_file_sha256']}
        expected_plan = {'path': str((self.cont / 'continuation-plan.json').resolve()),
                         'sha256': self.scope['continuation_plan_file_sha256']}
        locks = {'production_owner': not lock_is_held(owner_lock),
                 'publication': not lock_is_held(publication_lock),
                 'supervisor': not lock_is_held(supervisor_lock)}
        if (owner.get('schema_version') != 'snippy-production-owner-v1'
                or owner.get('owner_record_sha256') != object_digest(owner_unsigned)
                or owner.get('active') is not False or not owner.get('released_at')
                or owner.get('job_id') != self.config['job_id'] or owner.get('pid') != os.getpid()
                or owner.get('runtime_commit') != self.config['runtime_commit']
                or owner.get('continuation_authorization') != expected_authority
                or owner.get('continuation_plan') != expected_plan
                or owner.get('lock_path') != str(owner_lock.resolve())
                or continuation_owner_path.read_bytes() != owner_raw
                or not all(locks.values())):
            raise RuntimeError('Inactive production owner or released-lock proof failed')
        stop = read(stop_path)
        if stop.get('job_id') != self.config['job_id']:
            raise RuntimeError('Final STOP marker belongs to a different job')

        self.save(phase='owner_released_preparing_final_response', owner_active=False,
                  owner_locks_free=locks, own_children_alive=False)
        intent = self.load_final_response_intent()
        if intent and intent.get('status') == 'accepted':
            ready = self.canonical_ready_response(intent)
            if ready is None:
                raise RuntimeError('Accepted final response intent regressed to CLAIMED')
            response_id = ready['response_id']
        else:
            if intent is None:
                snapshot = self.checkpoint(final=True)
                if snapshot.get('new_fallback_ids') != []:
                    raise RuntimeError('Final checkpoint contains fallback IDs not delivered before verification')
                stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
                release = self.checkpoint_dir / ('fixed-subset-release-' + stamp + '-' + uuid.uuid4().hex[:8])
                release.mkdir(parents=True, exist_ok=False)
                shutil.copy2(root_owner_path, release / 'production-owner.json')
                shutil.copy2(stop_path, release / 'STOP.json')
                shutil.copy2(self.cont / 'final-verification.json', release / 'final-verification.json')
                receipt = {'schema_version': 'snippy-fixed-subset-owner-release-v1', 'created_at': now(),
                    'job_id': self.config['job_id'], 'supervisor_pid': os.getpid(),
                    'runtime_commit': self.config['runtime_commit'], 'owner_active': False,
                    'owner_record_sha256': owner['owner_record_sha256'],
                    'owner_record_file_sha256': file_sha256(root_owner_path),
                    'stop_file_sha256': file_sha256(stop_path), 'locks_free': locks,
                    'own_compute_children_alive': False,
                    'authorization_file_sha256': self.scope['authorization_file_sha256'],
                    'continuation_plan_file_sha256': self.scope['continuation_plan_file_sha256'],
                    'final_verification_file_sha256': file_sha256(self.cont / 'final-verification.json'),
                    'final_checkpoint_directory': snapshot['directory'],
                    'final_checkpoint_manifest_sha256': snapshot['manifest_file_sha256']}
                receipt['release_receipt_sha256'] = object_digest(receipt)
                atomic(release / 'owner-release-receipt.json', receipt)
                entries = [{'path': path.name, 'size': path.stat().st_size, 'sha256': file_sha256(path)}
                           for path in sorted(release.iterdir()) if path.is_file()]
                manifest = {'schema_version': 'snippy-fixed-subset-owner-release-manifest-v1',
                    'created_at': now(), 'job_id': self.config['job_id'], 'files': entries,
                    'file_count': len(entries), 'total_bytes': sum(item['size'] for item in entries)}
                manifest['manifest_sha256'] = object_digest(manifest)
                atomic(release / 'release-manifest.json', manifest)
                note = ('Frozen 340-ID Luna phase completed and final fixed-scope verifier passed. '
                    'The response was submitted only after the producer, publisher, and supervisor locks '
                    'were proven free and the production owner was durably inactive. Passing clips were '
                    'publication-readback verified; Astra/source holds remain explicitly skipped with '
                    'selected-only fallback evidence. No broad-batch artifacts or remote Astra calls are '
                    'included. Consumer validation/ack required.')
                intent = self.save_final_response_intent({
                    'schema_version': FINAL_RESPONSE_INTENT_SCHEMA, 'created_at': now(),
                    'job_id': self.config['job_id'], 'owner_instance': self.config['instance'],
                    'status': 'prepared', 'response_id': None,
                    'snapshot_directory': snapshot['directory'],
                    'snapshot_manifest_file_sha256': snapshot['manifest_file_sha256'],
                    'snapshot_manifest_sha256': snapshot['manifest_sha256'],
                    'snapshot_new_fallback_ids': snapshot['new_fallback_ids'],
                    'release_directory': str(release),
                    'release_manifest_file_sha256': file_sha256(release / 'release-manifest.json'),
                    'tag': 'fixed-subset-final-' + snapshot['manifest_sha256'][:12], 'note': note})
            response_arguments = (self.config['job_id'], intent['snapshot_directory'],
                                  intent['release_directory'], '--tag', intent['tag'], '--note', intent['note'])
            try:
                output = self.relay('respond', *response_arguments)
            except BaseException as respond_error:
                try:
                    ready = self.canonical_ready_response(intent)
                except BaseException as reconcile_error:
                    raise RuntimeError('Relay respond failed and canonical READY reconciliation failed') from respond_error
                if ready is None:
                    raise RuntimeError('Relay respond failed and canonical job remains CLAIMED') from respond_error
                response_id = ready['response_id']
                intent = self.accept_final_response_intent(intent, response_id, reconciled=True)
            else:
                match = re.search(r'\bR-[0-9a-f]{16}\b', output or '')
                if match:
                    response_id = match.group(0)
                else:
                    ready = self.canonical_ready_response(intent)
                    if ready is None:
                        raise RuntimeError('Relay respond returned success without canonical READY state')
                    response_id = ready['response_id']
                intent = self.accept_final_response_intent(intent, response_id)
        self.save(phase='response_ready', response_submitted_at=now(), own_children_alive=False,
                   owner_active=False, owner_locks_free=locks,
                   final_checkpoint_directory=intent['snapshot_directory'],
                   final_checkpoint_manifest_sha256=intent['snapshot_manifest_file_sha256'],
                   owner_release_directory=intent['release_directory'],
                   final_response_id=response_id, final_response_intent_sha256=intent['intent_sha256'])

    def run(self):
        from production import runner_lock
        quiescence_error = None
        # The root lock excludes every production coordinator, not merely a
        # second process using this continuation directory.
        with runner_lock(self.root / 'production-owner.lock'), runner_lock(self.cont / 'supervisor.lock'):
            # Never advertise an active production owner from an unpinned or
            # dirty checkout, even briefly.
            self.verify_runtime()
            self.write_owner_record()
            previous_pids = [self.state.get(key) for key in ('runner_pid', 'asr_pid', 'asr_launcher_pid')]
            if any(alive(pid) for pid in previous_pids):
                self.pause('Prior recorded compute PID still alive; orphan drain required before explicit resume')
                self.save(orphan_pids=[pid for pid in previous_pids if alive(pid)])
            self.save(phase='starting', desired=self.control['desired'], started_at=now(), self_test=self.self_test,
                      control_commands={'pause': 'SNIPPY_CONTROL PAUSE', 'resume': 'SNIPPY_CONTROL RESUME'})
            self.reader_thread = threading.Thread(
                target=self.remote_reader, daemon=True, name='snippy-remote-reader')
            self.worker_thread = threading.Thread(
                target=self.background, daemon=True, name='snippy-background-worker')
            self.reader_thread.start()
            self.worker_thread.start()
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
                    if time.monotonic() - self.last_remote_success > REMOTE_STALE_SECONDS and self.control['desired'] == 'running':
                        self.pause(f'Remote control reads stale beyond {REMOTE_STALE_SECONDS} seconds; explicit resume required after recovery')
                        self.enqueue('log', f"PAUSING because remote control polling is stale beyond{REMOTE_STALE_SECONDS}s; "
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
                            self.save(phase='paused', own_children_alive=False, runner_pid=None,
                                      asr_pid=None, asr_launcher_pid=None)
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
                        self.enqueue('log', f"Continuation {self.state.get('phase')}: coverage={coverage['covered']}/{coverage['requested']}, "
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
                # Never release root ownership while accepted runner/ASR work
                # remains alive. STOP is durable; children drain cooperatively.
                while not self.drained():
                    if self.self_test:
                        break
                    self.save(phase='exit_draining', own_children_alive=True)
                    time.sleep(1)
                try:
                    self.quiesce_background_threads()
                except BaseException as exc:
                    quiescence_error = exc
                    self.pending_final_response = None
                    self.save(phase='background_quiescence_failed',
                              error=f'{type(exc).__name__}: {exc}', automatic_restart=False)
                if self.owner_record is not None:
                    released = {**self.owner_record, 'active': False, 'released_at': now()}
                    released.pop('owner_record_sha256', None)
                    released['owner_record_sha256'] = object_digest(released)
                    atomic(self.root / 'production-owner.json', released)
                    atomic(self.cont / 'production-owner.json', released)
                    self.save(phase=('owner_deactivated_pending_lock_release'
                                     if self.pending_final_response else self.state.get('phase')),
                              owner_active=False, own_children_alive=False)
                for stream in self.open_logs:
                    stream.close()
        if quiescence_error is not None:
            raise quiescence_error
        if self.pending_final_response:
            try:
                self.submit_fixed_final_response()
            except BaseException as exc:
                self.save(phase='final_response_failed_after_owner_release',
                          error=f'{type(exc).__name__}: {exc}', own_children_alive=False,
                          owner_active=False, automatic_restart=False)
                raise
        return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('action', choices=('run', 'pause', 'resume', 'status', 'maintenance-pause',
                                           'maintenance-resume', 'set-batch-workers'), nargs='?', default='run')
    parser.add_argument('--reason', default='Operational maintenance drain')
    parser.add_argument('--batch-workers', type=int)
    args = parser.parse_args(argv)
    config = load_config(args.config)
    if args.action == 'maintenance-pause':
        print(json.dumps(submit_control(config, 'PAUSE', 'maintenance', {'reason': args.reason}), indent=2))
        return 0
    if args.action == 'maintenance-resume':
        request, blocker = submit_maintenance_resume(config, args.reason)
        if blocker:
            print(json.dumps({'resumed': False, 'blocker': blocker}, indent=2))
            return 2
        print(json.dumps(request, indent=2))
        return 0
    if args.action == 'set-batch-workers':
        print(json.dumps(write_batch_workers(config, args.batch_workers, args.reason), indent=2))
        return 0
    if args.action == 'status':
        print(json.dumps(read(Path(config['continuation_dir']) / 'status.json'), indent=2))
        return 0
    if args.action in ('pause', 'resume'):
        print(json.dumps(submit_control(config, args.action), indent=2))
        return 0
    return Supervisor(config, args.self_test).run()


if __name__ == '__main__':
    raise SystemExit(main())
