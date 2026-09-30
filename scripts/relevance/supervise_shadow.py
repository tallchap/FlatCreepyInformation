#!/usr/bin/env python3
"""Supervise one frozen ten-group experiment, then pause for cost confirmation."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import audit
from checkpoint_shadow import create_checkpoint
from production import runner_lock


def read(path):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--relay', type=Path, required=True)
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--private-env-file', type=Path, required=True)
    parser.add_argument('--whisper-python', type=Path, required=True)
    parser.add_argument('--relay-session-file', type=Path, required=True)
    parser.add_argument('--experiment-id', required=True)
    args = parser.parse_args()
    root, relay = args.root.resolve(), args.relay.resolve()
    scripts = Path(__file__).resolve().parent
    state_path = root / 'supervisor.json'
    state = read(state_path)
    state.update(supervisor_pid=os.getpid(), started_at=audit.now(), phase='starting')
    env = os.environ.copy()
    env['SNIPPY_WHISPER_PYTHON'] = str(args.whisper_python.resolve())
    env['PYTHONUTF8'] = '1'
    # The serialized supervisor and its exact children retain the claiming root's
    # wallet. This is not shared with any other agent or worker lane.
    if not args.relay_session_file.is_file():
        raise ValueError('The claiming private Relay wallet is unavailable')
    env['RELAY_SESSION_FILE'] = str(args.relay_session_file.resolve())
    env['RELAY_SESSION_PINNED'] = '1'
    env['RELAY_INSTANCE'] = 'shadow-snippy-codex-1644'
    env['RELAY_CAPS'] = 'shadow,windows,cuda,ffmpeg,codex'
    env['RELAY_SESSION'] = 'codex-snippy-1644-20260930-root-72cdd69a'
    def save(**values):
        state.update(time=audit.now(), **values)
        audit.atomic(state_path, state)
    def relay_command(*command):
        result = subprocess.run([sys.executable, '-X', 'utf8', str(relay / 'relay.py'), *command],
                                cwd=relay, env=env, capture_output=True, text=True, encoding='utf-8', timeout=900)
        with (root / 'supervisor-relay.log').open('a', encoding='utf-8') as log:
            log.write(audit.now() + ' ' + ' '.join(command[:2]) + '\n' + result.stdout + result.stderr + '\n')
        if result.returncode:
            raise RuntimeError('Relay progress command failed; see supervisor-relay.log')
        return result.stdout
    def checkpoint(status, final=False):
        subprocess.run([sys.executable, '-X', 'utf8', str(scripts / 'production_report.py'), '--root', str(root)],
                       cwd=relay, env=env, check=True, capture_output=True, timeout=120)
        result = create_checkpoint(root, root.parent / 'checkpoints')
        directory = result['directory']
        covered = status.get('covered', 0)
        relay_command('send', args.job_id, directory, '--kind', 'response', '--tag', f'snippy-1644-checkpoint-{covered}')
        relay_command('log', args.job_id, f"Checkpoint {covered}/1644; counts={status.get('counts')}; Luna usage-derived total=${status.get('luna_cost_usd',0):.6f}; current=${status.get('current_luna_cost_usd',0):.6f}; PID={status.get('pid')}; heartbeat={status.get('time')}; compact evidence={directory}; fetch this job --kind response. Claim remains active; Astra holds are unpublished.")
        save(last_checkpoint_covered=covered, last_checkpoint_directory=directory, last_checkpoint_at=audit.now())
    command = [sys.executable, '-X', 'utf8', str(scripts / 'production.py'), '--root', str(root),
               '--whisper-cli', str(scripts / 'whisper_cuda.py'), '--machine', 'Shadow',
               '--private-env-file', str(args.private_env_file.resolve()), '--batch-workers', '10',
               '--max-batches', '10', '--experiment-id', args.experiment_id]
    with runner_lock(root / 'supervisor.lock'):
        try:
            prior = read(root / 'prior-verification.json')
            asr = read(root / 'cuda-roundtrip-verification.json')
            if not prior.get('passed') or not asr.get('passed'):
                raise ValueError('Prior publication and actual CUDA roundtrip gates must pass first')
            for attempt in range(state.get('attempt', 0) + 1, 4):
                log_path = root / f'production-attempt-{attempt}-{int(time.time())}.log'
                with log_path.open('w', encoding='utf-8') as output:
                    process = subprocess.Popen(command, cwd=relay, env=env, stdout=output, stderr=subprocess.STDOUT)
                    save(phase='running', attempt=attempt, runner_pid=process.pid, runner_log=str(log_path))
                    last_log = time.monotonic()
                    while process.poll() is None:
                        status = read(root / 'status.json')
                        save(runner_status=status)
                        covered = status.get('covered', 0)
                        last_covered = state.get('last_checkpoint_covered', 20)
                        need_first = covered >= 25 and last_covered < 25
                        if need_first or covered // 100 > last_covered // 100:
                            try:
                                checkpoint(status)
                            except Exception as exc:
                                save(checkpoint_error=str(exc))
                        if time.monotonic() - last_log >= 180:
                            try:
                                relay_command('log', args.job_id, f"Running {covered}/1644; remaining={status.get('remaining')}; counts={status.get('counts')}; Luna total=${status.get('luna_cost_usd',0):.6f}; PID={process.pid}; heartbeat={status.get('time')}; phase={status.get('phase')}")
                                last_log = time.monotonic()
                            except Exception as exc:
                                save(relay_error=str(exc))
                        time.sleep(15)
                status = read(root / 'status.json')
                save(exit_code=process.returncode, runner_status=status)
                if process.returncode == 0:
                    checkpoint(status, final=True)
                    save(phase='paused_for_cost_confirmation', admission_stopped=True)
                    relay_command('log', args.job_id, f"Bounded ten-group experiment exited cleanly. Admissions STOPPED for cost confirmation; no further production launched. Coverage={status.get('covered')}/1644;counts={status.get('counts')};currentLuna=${status.get('current_luna_cost_usd',0):.6f}. Root is verifying benchmark/cost evidence; pending Astra clips remain untouched.")
                    return 0
                relay_command('log', args.job_id, f"Runner exited {process.returncode} at {status.get('covered')}/1644; bounded recovery {attempt}/3; error={status.get('error')}; log={log_path}. Successful hashes and paid-call receipts retained.")
            save(phase='recovery_exhausted')
            return 1
        except Exception as exc:
            save(phase='supervisor_error', error=f'{type(exc).__name__}: {exc}')
            raise


if __name__ == '__main__':
    raise SystemExit(main())
