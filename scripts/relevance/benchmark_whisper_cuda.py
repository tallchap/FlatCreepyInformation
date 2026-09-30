#!/usr/bin/env python3
"""Bounded offline comparison: exactly two cached final clips, fresh CLI vs resident ASR.

Run only after the shared GPU is clear. Four independent transcriptions total;
no media downloads, paid calls, source-ASR substitution or production admission.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import whisper_cuda as adapter


def compare_records(media, baseline, resident):
    left, right = baseline['words'], resident['words']
    same_text = [w['text'] for w in left] == [w['text'] for w in right]
    delta = max((abs(a[k] - b[k]) for a, b in zip(left, right) for k in ('start', 'end')), default=0) if same_text else None
    fields = ('engine', 'engine_version', 'ctranslate2_version', 'model', 'model_repository',
              'model_cache_path', 'device', 'device_index', 'compute_type', 'requested_fp16',
              'threads', 'local_files_only', 'beam_size', 'vad_filter', 'condition_on_previous_text')
    digest = adapter.sha256(media)
    checks = {'same_word_text': same_text, 'word_timestamps_identical': delta == 0,
              'same_model_and_inference_parameters': all(baseline['provider'].get(k) == resident['provider'].get(k) for k in fields),
              'both_bound_to_exact_final_media': all(r['provider']['input_sha256'] == digest for r in (baseline, resident)),
              'both_actual_small_en_cuda_float32': all(r['provider']['model'] == 'small.en' and
                    r['provider']['device'] == 'cuda' and r['provider']['compute_type'] == 'float32' for r in (baseline, resident))}
    return {'checks': checks, 'max_word_timestamp_delta_seconds': delta, 'word_count': len(left),
            'media_sha256': digest, 'passed': all(checks.values())}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--media-root', type=Path, required=True)
    parser.add_argument('--media', type=Path, nargs=2, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--stop-file', type=Path, required=True)
    parser.add_argument('--python', required=True)
    args = parser.parse_args(argv)
    if args.output.exists() or args.config.exists() or args.stop_file.exists():
        raise ValueError('Use new output/config/stop paths; existing evidence must remain immutable')
    root = args.media_root.resolve()
    media = [p.resolve() for p in args.media]
    if args.config.resolve().is_relative_to(root):
        raise ValueError('Private endpoint config must be outside the run root')
    if len(set(media)) != 2:
        raise ValueError('Exactly two distinct cached final media files are required')
    for path in media:
        receipt = json.loads((path.parent / 'result.json').read_text(encoding='utf-8'))
        if not path.is_relative_to(root) or adapter.sha256(path) != receipt['output_sha256']:
            raise ValueError('Cached final media failed its render receipt hash')
    args.output.mkdir(parents=True)
    script = Path(__file__).resolve().parent
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    env = {**os.environ, 'SNIPPY_WHISPER_SERVER_CONFIG': str(args.config.resolve()),
           'SNIPPY_STOP_FILE': str(args.stop_file.resolve())}
    def command(adapter_name, path, out):
        return [args.python, '-X', 'utf8', str(script / adapter_name), str(path), '--model', 'small.en',
                '--language', 'en', '--output_dir', str(out), '--output_format', 'json',
                '--fp16', 'False', '--threads', '8', '--word_timestamps', 'True']
    def measure(adapter_name, path, out):
        out.mkdir(parents=True)
        started = time.perf_counter()
        with (out / 'process.log').open('w', encoding='utf-8') as log:
            subprocess.run(command(adapter_name, path, out), env=env, stdout=log, stderr=subprocess.STDOUT,
                           check=True, timeout=600, creationflags=flags)
        elapsed = time.perf_counter() - started
        evidence = out / (path.stem + '.json')
        return elapsed, evidence, json.loads(evidence.read_text(encoding='utf-8'))
    baseline = [measure('whisper_cuda.py', path, args.output / 'fresh-cli' / str(i + 1)) for i, path in enumerate(media)]
    started_at = datetime.now(timezone.utc).isoformat()
    server_started = time.perf_counter()
    with (args.output / 'server.log').open('w', encoding='utf-8') as log:
        server = subprocess.Popen([args.python, '-X', 'utf8', str(script / 'whisper_cuda_server.py'),
            '--media-root', str(root), '--config', str(args.config.resolve()), '--stop-file', str(args.stop_file.resolve())],
            env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    try:
        deadline = time.monotonic() + 120
        while not args.config.exists():
            if server.poll() is not None:
                raise RuntimeError('Local CUDA server failed startup; inspect server.log')
            if time.monotonic() > deadline:
                raise RuntimeError('Local CUDA server startup exceeded 120 seconds')
            time.sleep(.05)
        startup = time.perf_counter() - server_started
        persistent = [measure('whisper_cuda_client.py', path, args.output / 'resident' / str(i + 1)) for i, path in enumerate(media)]
    finally:
        adapter.write_json(args.stop_file, {'reason': 'Bounded local ASR benchmark finished; no new admission'})
        server.wait(timeout=60)  # No kill: accepted local ASR must finish.
    rows = []
    for i, path in enumerate(media):
        cold_seconds, cold_path, cold = baseline[i]
        warm_seconds, warm_path, warm = persistent[i]
        rows.append({'media': str(path), 'audio_duration_seconds': cold['audio_duration_secs'],
            'fresh_cli_wall_seconds': cold_seconds, 'resident_client_wall_seconds': warm_seconds,
            'seconds_saved': cold_seconds - warm_seconds,
            'observed_speed_ratio': cold_seconds / warm_seconds,
            'resident_state': 'first request after model load' if i == 0 else 'warm subsequent request',
            'fresh_cli_evidence': str(cold_path), 'fresh_cli_evidence_sha256': adapter.sha256(cold_path),
            'resident_evidence': str(warm_path), 'resident_evidence_sha256': adapter.sha256(warm_path),
            'provider': warm['provider'], **compare_records(path, cold, warm)})
    report = {'schema_version': 'snippy-local-asr-microbenchmark-v1', 'generated_at': datetime.now(timezone.utc).isoformat(),
        'resident_started_at': started_at, 'server_startup_wall_seconds': startup, 'server_pid': server.pid,
        'server_exit_code': server.returncode, 'independent_transcription_count': 4, 'rows': rows,
        'fresh_cli_total_seconds': sum(r['fresh_cli_wall_seconds'] for r in rows),
        'resident_calls_total_seconds': sum(r['resident_client_wall_seconds'] for r in rows),
        'resident_including_startup_total_seconds': startup + sum(r['resident_client_wall_seconds'] for r in rows),
        'passed': all(r['passed'] for r in rows) and server.returncode == 0,
        'limitations': ['Two cached final media samples; no general throughput extrapolation.',
            'First resident request includes first-inference effects; only the second request is subsequently warm.',
            'CLI baseline ran first; filesystem and GPU caches may affect these observations.',
            'Same small.en CUDA float32 and inference flags; independent ASR runs on every final media file.']}
    adapter.write_json(args.output / 'report.json', report)
    lines = ['# Local CUDA ASR microbenchmark', '',
        '| Clip | Seconds of audio | Fresh CLI (s) | Resident client (s) | Saved (s) | Evidence |',
        '|---|---:|---:|---:|---:|---|']
    for row in rows:
        lines.append(f"| {Path(row['media']).parent.name} | {row['audio_duration_seconds']:.2f} | {row['fresh_cli_wall_seconds']:.3f} | {row['resident_client_wall_seconds']:.3f} | {row['seconds_saved']:.3f} | {'PASS' if row['passed'] else 'FAIL'} |")
    lines += ['', f'Server startup: {startup:.3f} s. Four independent transcriptions; server stopped normally.', '',
              *['- ' + text for text in report['limitations']], '', 'Exact hashes, timestamps, runtime and receipts: [report.json](report.json).', '']
    (args.output / 'report.md').write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({'report': str(args.output / 'report.json'), 'passed': report['passed'],
                      'fresh_cli_seconds': report['fresh_cli_total_seconds'],
                      'resident_calls_seconds': report['resident_calls_total_seconds'],
                      'resident_with_startup_seconds': report['resident_including_startup_total_seconds']}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
