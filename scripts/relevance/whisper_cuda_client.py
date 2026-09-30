#!/usr/bin/env python3
"""Drop-in Whisper CLI client for an explicitly started local CUDA service."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

import whisper_cuda as adapter
from whisper_cuda_server import PROTOCOL, check_stop, parameters


def transcribe(args, config_path):
    config = json.loads(Path(config_path).read_text(encoding='utf-8'))
    if (config.get('protocol') != PROTOCOL or config.get('host') != '127.0.0.1' or
            type(config.get('port')) is not int or not 1 <= config['port'] <= 65535 or
            not isinstance(config.get('token'), str) or len(config['token']) < 32):
        raise ValueError('Invalid local ASR endpoint configuration')
    requested = parameters(args.fp16, args.threads, args.download_root)
    if requested != config.get('parameters'):
        raise ValueError('CLI parameters differ from the resident ASR model')
    stops = {Path(config['stop_file'])}
    if os.environ.get('SNIPPY_STOP_FILE'):
        stops.add(Path(os.environ['SNIPPY_STOP_FILE']))
    for stop in stops:
        check_stop(stop)
    source = args.media.resolve()
    if not source.is_file() or not source.is_relative_to(Path(config['media_root']).resolve()):
        raise ValueError('Media must be inside the configured job root')
    digest = adapter.sha256(source)
    request = {'protocol': PROTOCOL, 'media': str(source), 'input_sha256': digest, 'parameters': requested}
    for stop in stops:
        check_stop(stop)
    call = urllib.request.Request(f"http://127.0.0.1:{config['port']}/transcribe",
        data=json.dumps(request).encode('utf-8'), method='POST',
        headers={'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'})
    # Ignore machine proxy settings: this IPC must never leave loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(call, timeout=1800) as response:
            record = json.load(response)
    except urllib.error.HTTPError as exc:
        body = json.loads(exc.read())
        raise RuntimeError(f"Local ASR rejected request ({exc.code}): {body.get('error', 'unknown error')}") from None
    provider = record.get('provider') or {}
    if (provider.get('input_sha256') != digest or adapter.sha256(source) != digest or
            Path(provider.get('input_path', '')).resolve() != source):
        raise ValueError('Returned ASR media hash/path does not bind the requested final media')
    if (provider.get('model') != adapter.MODEL or provider.get('device') != 'cuda' or
            provider.get('compute_type') != ('float16' if args.fp16 else 'float32') or
            provider.get('requested_fp16') != args.fp16 or provider.get('threads') != args.threads or
            provider.get('beam_size') != 5 or provider.get('vad_filter') is not False or
            provider.get('condition_on_previous_text') is not False or
            (provider.get('persistent_server') or {}).get('session_id') != config.get('session_id')):
        raise ValueError('Returned ASR runtime/parameters differ from the requested CUDA contract')
    previous = -1.0
    if not record.get('words'):
        raise ValueError('Returned ASR has no word timestamps')
    for word in record['words']:
        start, end = word['start'], word['end']
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start <= end and start >= previous):
            raise ValueError('Returned ASR word timestamps are invalid')
        previous = start
    return record


def main(argv=None):
    args = adapter.parser().parse_args(argv)
    config_path = os.environ.get('SNIPPY_WHISPER_SERVER_CONFIG')
    if not config_path:
        raise ValueError('SNIPPY_WHISPER_SERVER_CONFIG must name an explicitly started local CUDA server')
    record = transcribe(args, config_path)
    output = args.output_dir / (args.media.stem + '.json')
    adapter.write_json(output, record)
    provider = record['provider']
    print(json.dumps({'output': str(output), 'words': len(record['words']), 'model': provider['model'],
                      'device': provider['device'], 'compute_type': provider['compute_type'],
                      'persistent_request_number': provider['persistent_server']['request_number']}), flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        raise SystemExit(1)
