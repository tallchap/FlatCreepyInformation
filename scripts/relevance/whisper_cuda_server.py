#!/usr/bin/env python3
"""Single-model local CUDA ASR service. Explicit launch only; no fallback/retries."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import sys
import time
import uuid

import whisper_cuda as adapter

PROTOCOL = 'snippy-local-cuda-asr-v1'
MAX_REQUEST_BYTES = 16384


def now():
    return datetime.now(timezone.utc).isoformat()


def check_stop(path):
    if Path(path).exists():
        raise RuntimeError('ASR admission stopped by marker: ' + str(path))


def parameters(fp16=False, threads=8, download_root=None):
    return {'model': adapter.MODEL, 'language': 'en', 'device': 'cuda', 'fp16': fp16,
            'threads': threads, 'word_timestamps': True, 'download_root': download_root}


class ASRService:
    def __init__(self, media_root, stop_file, model, provider, token, params, load_seconds=0):
        self.media_root = Path(media_root).resolve()
        self.stop_file = Path(stop_file).resolve()
        self.model, self.provider, self.token, self.params = model, provider, token, params
        self.load_seconds = load_seconds
        self.session_id, self.requests = uuid.uuid4().hex, 0

    def transcribe(self, request):
        if request.get('protocol') != PROTOCOL or request.get('parameters') != self.params:
            raise ValueError('ASR protocol/parameters differ from the resident model')
        source = Path(request['media']).resolve()
        if not source.is_relative_to(self.media_root) or not source.is_file():
            raise ValueError('Media must be an existing file inside the configured job root')
        check_stop(self.stop_file)  # Accepted work finishes even if a marker arrives later.
        if adapter.sha256(source) != request.get('input_sha256'):
            raise ValueError('Media hash differs from client admission hash')
        check_stop(self.stop_file)
        self.requests += 1
        started_at, started = now(), time.perf_counter()
        record = adapter.transcribe_media(source, self.model, self.provider)
        record['provider']['persistent_server'] = {
            'protocol': PROTOCOL, 'session_id': self.session_id, 'pid': os.getpid(),
            'request_number': self.requests, 'model_load_seconds': self.load_seconds,
            'started_at': started_at, 'finished_at': now(),
            'transcribe_with_media_hashes_seconds': time.perf_counter() - started,
            'independent_transcription_of_requested_media': True}
        return record


def make_server(service):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *args):
            pass  # Never log bearer headers or payloads.

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            supplied = self.headers.get('Authorization', '')
            if not hmac.compare_digest(supplied, 'Bearer ' + service.token):
                self.reply(403, {'error': 'Local ASR authentication failed'})
                return
            if self.path != '/transcribe':
                self.reply(404, {'error': 'Unknown endpoint'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= MAX_REQUEST_BYTES:
                    raise ValueError('Invalid local ASR request size')
                request = json.loads(self.rfile.read(size))
                if not isinstance(request, dict):
                    raise ValueError('ASR request must be an object')
                record = service.transcribe(request)
            except (ValueError, KeyError) as exc:
                self.reply(400, {'error': str(exc), 'type': type(exc).__name__})
            except Exception as exc:
                self.reply(503, {'error': str(exc), 'type': type(exc).__name__})
            else:
                self.reply(200, record)

    return HTTPServer(('127.0.0.1', 0), Handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--media-root', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True, help='Private endpoint file; never include in checkpoints')
    parser.add_argument('--stop-file', type=Path, required=True)
    parser.add_argument('--fp16', type=adapter.boolean, choices=[False], default=False)
    parser.add_argument('--threads', type=int, choices=[8], default=8)
    parser.add_argument('--download-root', default=None)
    args = parser.parse_args(argv)
    if not args.media_root.is_dir():
        raise ValueError('Media root must exist')
    if args.config.exists():
        raise ValueError('Endpoint config already exists; explicit cleanup of the stopped server is required')
    check_stop(args.stop_file)
    started = time.perf_counter()
    model, provider = adapter.load_model(args.fp16, args.threads, args.download_root)
    load_seconds = time.perf_counter() - started
    service = ASRService(args.media_root, args.stop_file, model, provider, secrets.token_urlsafe(32),
                         parameters(args.fp16, args.threads, args.download_root), load_seconds)
    server = make_server(service)
    config = {'protocol': PROTOCOL, 'host': '127.0.0.1', 'port': server.server_port,
              'token': service.token, 'pid': os.getpid(), 'session_id': service.session_id,
              'media_root': str(service.media_root), 'stop_file': str(service.stop_file),
              'parameters': service.params, 'provider': provider, 'model_load_seconds': load_seconds}
    args.config.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive create prevents a second instance replacing the endpoint.
    fd = os.open(args.config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(config, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'ready': True, 'pid': os.getpid(), 'config': str(args.config),
                      'model': provider['model'], 'device': provider['device'],
                      'compute_type': provider['compute_type'], 'model_load_seconds': load_seconds}), flush=True)
    server.timeout = 0.5
    try:
        while not args.stop_file.exists():
            server.handle_request()
    finally:
        server.server_close()
        # Preserve the named endpoint as an explicit stopped-server receipt.
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        raise SystemExit(1)
