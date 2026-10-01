#!/usr/bin/env python3
"""Validate Astra recipes and render local previews. No upload or database writes.

Range receipts measure HTTP response-body bytes consumed by this process, including
read-ahead before cancellation, not TLS overhead or provider-billed network bytes.
"""
import argparse
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

import audit
import encoding
from captions import parse_captions


def require(value, message):
    if not value:
        raise ValueError(message)


class SourceIntegrityError(ValueError):
    """A generation-pinned source object is structurally incomplete."""
    def __init__(self, message, evidence=None):
        super().__init__(message)
        self.evidence = evidence


def inspect_mp4_extents(object_size, read_range):
    """Prove that every declared top-level MP4 box fits in the object.

    Only box headers are read. This catches fast-start files whose `moov`
    sample tables describe media in a physically truncated `mdat` before an
    encoder can mistake chapter metadata for a successful A/V render.
    """
    if type(object_size) is not int or object_size < 0:
        raise ValueError('Source object size must be a nonnegative integer')
    if object_size < 8:
        return {'schema_version': 'snippy-mp4-extents-v1',
                'object_size': object_size, 'boxes': [], 'applicable': False,
                'complete': None, 'error': None,
                'not_applicable_reason': 'no_isobmff_ftyp_header'}
    offset, boxes = 0, []
    while offset < object_size:
        if len(boxes) >= 4096:
            return {'schema_version': 'snippy-mp4-extents-v1',
                    'object_size': object_size, 'boxes': boxes,
                    'applicable': True, 'complete': None, 'error': None,
                    'inspection_inconclusive_reason': 'top_level_box_limit',
                    'next_offset': offset}
        remaining = object_size - offset
        if remaining < 8:
            evidence = {'schema_version': 'snippy-mp4-extents-v1',
                        'object_size': object_size, 'boxes': boxes,
                        'complete': False, 'error': 'trailing_partial_box_header',
                        'offset': offset, 'remaining_bytes': remaining}
            raise SourceIntegrityError('Source MP4 ends inside a box header', evidence)
        header = read_range(offset, min(offset + 15, object_size - 1))
        if len(header) < 8:
            evidence = {'schema_version': 'snippy-mp4-extents-v1',
                        'object_size': object_size, 'boxes': boxes,
                        'complete': False, 'error': 'short_box_header',
                        'offset': offset, 'received_bytes': len(header)}
            raise SourceIntegrityError('Source MP4 box header range was short', evidence)
        declared_size = int.from_bytes(header[:4], 'big')
        box_type_bytes = header[4:8]
        box_type = box_type_bytes.decode('latin-1')
        if offset == 0 and box_type_bytes != b'ftyp':
            return {'schema_version': 'snippy-mp4-extents-v1',
                    'object_size': object_size, 'boxes': [], 'applicable': False,
                    'complete': None, 'error': None,
                    'not_applicable_reason': 'no_isobmff_ftyp_header',
                    'first_box_type_latin1': box_type}
        header_size = 8
        if declared_size == 1:
            if len(header) < 16:
                evidence = {'schema_version': 'snippy-mp4-extents-v1',
                            'object_size': object_size, 'boxes': boxes,
                            'complete': False, 'error': 'short_extended_box_header',
                            'offset': offset, 'type': box_type}
                raise SourceIntegrityError('Source MP4 extended box header was short', evidence)
            declared_size, header_size = int.from_bytes(header[8:16], 'big'), 16
        elif declared_size == 0:
            declared_size = remaining
        end = offset + declared_size
        entry = {'offset': offset, 'type': box_type, 'header_size': header_size,
                 'declared_size': declared_size, 'declared_end': end}
        boxes.append(entry)
        if declared_size < header_size:
            evidence = {'schema_version': 'snippy-mp4-extents-v1',
                        'object_size': object_size, 'boxes': boxes,
                        'complete': False, 'error': 'invalid_box_size'}
            raise SourceIntegrityError('Source MP4 has an invalid top-level box size', evidence)
        if end > object_size:
            entry['missing_bytes'] = end - object_size
            evidence = {'schema_version': 'snippy-mp4-extents-v1',
                        'object_size': object_size, 'boxes': boxes,
                        'complete': False, 'error': 'declared_box_past_object_end'}
            raise SourceIntegrityError(
                f'Source MP4 is truncated: {box_type!r} declares {end} bytes '
                f'but immutable object size is {object_size}', evidence)
        offset = end
    return {'schema_version': 'snippy-mp4-extents-v1',
            'object_size': object_size, 'boxes': boxes, 'applicable': True,
            'complete': True, 'error': None, 'not_applicable_reason': None}


def inspect_proxy_mp4_extents(url, object_size):
    def read_range(start, end):
        with urlopen(Request(url, headers={'Range': f'bytes={start}-{end}'}), timeout=45) as response:
            if response.status != 206:
                raise RuntimeError('Source proxy did not honor MP4 header range')
            body = response.read()
            if len(body) != end - start + 1:
                raise RuntimeError('Source proxy returned a short MP4 header range')
            return body
    return inspect_mp4_extents(object_size, read_range)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def validate(recipe, packet, source, forbidden):
    require(isinstance(recipe, dict), 'Recipe must be an object')
    require(recipe.get('schema_version') == 'snippy-astra-edit-v1', 'Wrong schema')
    vid = recipe.get('candidate_id')
    require(vid == packet['candidate_id'] == source['video_id'], 'Candidate membership mismatch')
    require(vid not in forbidden, 'Culled candidate is forbidden')
    require(packet.get('lane') in ('eligible', 'review'), 'Candidate is not eligible for review')
    source_copy = {k: v for k, v in source.items() if k != 'input_hash'}
    require(source['input_hash'] == audit.digest(source_copy), 'Source snapshot hash invalid')
    require(recipe.get('source_input_hash') == packet['source_input_hash'] == source['input_hash'], 'Stale source_input_hash')
    require(hashlib.sha256(source['transcript'].encode()).hexdigest() == packet['full_transcript_sha256'], 'Transcript hash mismatch')
    for field in ('title', 'speaker', 'reason', 'edit_notes'):
        require(isinstance(recipe.get(field), str), f'Missing string {field}')
    decision = recipe.get('decision')
    require(decision in ('approve', 'revise', 'reject', 'needs_context'), 'Unknown decision')
    edits = recipe.get('edits')
    require(isinstance(edits, list), 'edits must be an array')
    if decision in ('reject', 'needs_context'):
        require(recipe.get('clip_worthy') is False and not edits, 'Rejected/unresolved recipe must have no edits')
        return {'renderable': False, 'duration_seconds': 0}
    require(recipe.get('clip_worthy') is True and edits, 'Approved recipe needs edits')
    require(recipe['title'].strip() and recipe['speaker'].strip() and recipe['reason'].strip(), 'Missing editorial metadata')
    captions = parse_captions(source['transcript'])
    times = {t for t, _ in captions}
    times.add(float(packet['source_duration_seconds']))
    previous, total = -1, 0
    for edit in edits:
        require(isinstance(edit, dict), 'Invalid edit')
        start, end = edit.get('start_seconds'), edit.get('end_seconds')
        require(all(type(v) in (float, int) and math.isfinite(v) for v in (start, end)), 'Nonfinite/nonnumeric timestamps')
        require(0 <= start < end <= packet['source_duration_seconds'], 'Range outside source')
        require(start >= previous, 'Edits must be sorted and nonoverlapping')
        require(start in times and end in times, 'Range must align to caption boundaries')
        require(packet['context_start_seconds'] <= start < end <= packet['context_end_seconds'], 'Range exceeds reviewed context')
        expected = ' '.join(text for t, text in captions if start <= t < end)
        require(isinstance(edit.get('transcript'), str) and ' '.join(edit['transcript'].split()) == ' '.join(expected.split()), 'Transcript must include ALL verbatim captions in range')
        previous, total = end, total + end - start
    require(15 <= total <= 240, 'Total duration must be 15–240 seconds')
    if decision == 'approve':
        proposal = packet['luna_proposal']
        require(len(edits) == 1 and edits[0]['start_seconds'] == proposal['start_seconds'] and edits[0]['end_seconds'] == proposal['end_seconds'], 'Changed boundaries require revise')
    require(len(edits) == 1 or bool(recipe['edit_notes'].strip()), 'Multiple edits require omission rationale')
    obj = packet.get('gcs_object')
    require(isinstance(obj, dict) and all(obj.get(k) for k in ('bucket', 'name', 'generation', 'size')), 'Missing source object')
    require(obj['name'] == f'videos/{vid}.mp4', 'Unexpected source object')
    return {'renderable': True, 'duration_seconds': total}


def load_inputs(args):
    recipe = json.loads(args.recipe.read_text())
    vid = recipe.get('candidate_id', '')
    require(re.fullmatch(r'[A-Za-z0-9_-]{11}', vid), 'Invalid candidate ID')
    packet = json.loads((args.packets / f'{vid}.json').read_text())
    source = next((r for r in audit.inputs(args.audit_run) if r['video_id'] == vid), None)
    require(source is not None, 'Candidate missing from immutable snapshot')
    forbidden = {r['video_id'] for r in json.loads(args.culled.read_text())}
    return recipe, packet, validate(recipe, packet, source, forbidden)


class _LocalClientDisconnected(Exception):
    """A disconnect observed only while writing the loopback HTTP response."""
    def __init__(self, operation, error):
        super().__init__(str(error))
        self.operation, self.error = operation, error


def _downstream_io(operation, function, *args):
    try:
        return function(*args)
    except OSError as exc:
        # Python maps ECONNABORTED to ConnectionAbortedError; native Windows
        # socket writers can also expose WSAECONNABORTED (10053) on OSError.
        # This wrapper is never applied to upstream GCS requests or reads.
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)) or getattr(exc, 'winerror', None) == 10053:
            raise _LocalClientDisconnected(operation, exc) from exc
        raise


class RangeProxy:
    """Single-object, loopback-only authenticated proxy; no arbitrary URLs accepted."""
    def __init__(self, session, obj, max_bytes, page_bytes=1024 * 1024, cache_root=None):
        self.session, self.obj, self.max_bytes = session, obj, max_bytes
        require(max_bytes > 0 and page_bytes > 0, 'Transfer/page budgets must be positive')
        self.page_bytes, self.bytes_requested = page_bytes, 0
        self.receipts, self.bytes_read, self.errors = [], 0, []
        self.cache_bytes_read, self.cache_hits = 0, 0
        from range_cache import OriginalRangeCache
        self.cache = OriginalRangeCache(cache_root, obj) if cache_root else None
        self.lock = threading.Lock()
        self.path = '/' + secrets.token_hex(24) + '.mp4'
        self.api = 'https://storage.googleapis.com/storage/v1/b/' + quote(obj['bucket'], safe='') + '/o/' + quote(obj['name'], safe='')
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *args):
                pass
            def do_HEAD(self):
                if self.path != owner.path:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Length', owner.obj['size'])
                self.send_header('Accept-Ranges', 'bytes')
                self.end_headers()
            def do_GET(self):
                if self.path != owner.path:
                    self.send_error(404)
                    return
                requested = self.headers.get('Range', 'bytes=0-')
                if not re.fullmatch(r'bytes=\d+-\d*', requested):
                    self.send_error(416)
                    return
                lo, hi = requested[6:].split('-')
                start, size = int(lo), int(owner.obj['size'])
                end = min(int(hi), size - 1) if hi else size - 1
                if start >= size or start > end:
                    self.send_error(416)
                    return
                receipt = {'range': requested, 'content_range': f'bytes {start}-{end}/{size}', 'bytes_read': 0, 'cancelled': False, 'started_at': audit.now(), 'pages': [], 'upstream_response_content_length': 0}
                with owner.lock:
                    owner.receipts.append(receipt)
                self.close_connection = True
                self.connection.settimeout(30)
                response = None
                try:
                    cursor = start
                    sent_headers = False
                    while cursor <= end:
                        page_end = min(end, cursor + owner.page_bytes - 1)
                        cached = owner.cache.load(cursor, page_end) if owner.cache else None
                        # Reserve the entire bounded response before requesting it. This
                        # caps potential egress even if GCS fills unread socket buffers.
                        with owner.lock:
                            remaining = owner.max_bytes - owner.bytes_requested
                            require(cached is not None or remaining > 0, 'Transfer budget exhausted; no automatic fallback')
                            if cached is None:
                                page_end = min(page_end, cursor + remaining - 1)
                            requested_size = page_end - cursor + 1
                            if cached is None:
                                owner.bytes_requested += requested_size
                            else:
                                owner.cache_hits += 1
                        page = {'range': f'bytes={cursor}-{page_end}', 'bytes_read': 0,
                                'requested_bytes': requested_size if cached is None else 0, 'cache_hit': cached is not None}
                        receipt['pages'].append(page)
                        if cached is None:
                            response = owner.session.get(owner.api, params={'alt': 'media', 'generation': owner.obj['generation'], 'ifGenerationMatch': owner.obj['generation']}, headers={'Range': page['range'], 'Accept-Encoding': 'identity'}, stream=True, timeout=(15, 45))
                        else:
                            from range_cache import CachedResponse
                            response = CachedResponse(cached, owner.obj, cursor, page_end)
                        page['status'] = response.status_code
                        page['content_range'] = response.headers.get('Content-Range')
                        page['response_content_length'] = int(response.headers.get('Content-Length', 0))
                        if cached is None:
                            receipt['upstream_response_content_length'] += page['response_content_length']
                        captured = bytearray()
                        require(response.status_code == 206, 'GCS did not honor range; refusing full-download fallback')
                        require(page['content_range'] == f'bytes {cursor}-{page_end}/{size}', 'GCS returned mismatched Content-Range')
                        require(page['response_content_length'] == requested_size, 'GCS returned mismatched Content-Length')
                        require(response.headers.get('Content-Encoding', 'identity') == 'identity', 'Compressed response cannot be byte-counted safely')
                        require(response.headers.get('x-goog-generation', owner.obj['generation']) == owner.obj['generation'], 'GCS generation changed')
                        if not sent_headers:
                            # FFmpeg sees its full requested range; pages are invisible
                            # to its demuxer and every upstream request has an explicit end.
                            self.send_response(206)
                            self.send_header('Content-Length', str(end - start + 1))
                            self.send_header('Content-Range', receipt['content_range'])
                            self.send_header('Content-Type', response.headers.get('Content-Type', 'video/mp4'))
                            self.send_header('Accept-Ranges', 'bytes')
                            self.send_header('Connection', 'close')
                            _downstream_io('headers', self.end_headers)
                            sent_headers = True
                        while page['bytes_read'] < requested_size:
                            chunk = response.raw.read(min(16384, requested_size - page['bytes_read']), decode_content=False)
                            require(chunk, 'GCS response ended before promised range')
                            with owner.lock:
                                if cached is None:
                                    owner.bytes_read += len(chunk)
                                    receipt['bytes_read'] += len(chunk)
                                    if owner.cache:
                                        captured.extend(chunk)
                                else:
                                    owner.cache_bytes_read += len(chunk)
                                page['bytes_read'] += len(chunk)
                            _downstream_io('body', self.wfile.write, chunk)
                        if owner.cache and cached is None:
                            owner.cache.save(cursor, page_end, bytes(captured))
                        response.close()
                        response = None
                        cursor = page_end + 1
                    _downstream_io('flush', self.wfile.flush)
                except _LocalClientDisconnected as exc:
                    receipt['cancelled'] = True
                    receipt['downstream_disconnect'] = {'operation': exc.operation,
                        'error_type': type(exc.error).__name__, 'errno': exc.error.errno,
                        'winerror': getattr(exc.error, 'winerror', None), 'message': str(exc.error)}
                except Exception as exc:
                    receipt['error'] = str(exc)
                    with owner.lock:
                        owner.errors.append(str(exc))
                finally:
                    if response is not None:
                        response.close()
                    receipt['finished_at'] = audit.now()

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    @property
    def url(self):
        return f'http://127.0.0.1:{self.server.server_port}{self.path}'

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def report(self):
        return {'original_cache_covered_range_hits': self.cache.covered_range_hits if self.cache else 0, 'original_cache_exact_range_hits': self.cache.exact_range_hits if self.cache else 0, 'original_cache_body_bytes_read': self.cache_bytes_read, 'original_cache_page_hits': self.cache_hits, 'original_cache_enabled': self.cache is not None, 'upstream_body_bytes_read': self.bytes_read, 'upstream_requested_bytes': self.bytes_requested, 'upstream_page_bytes': self.page_bytes, 'conservative_response_bytes_upper_bound': sum(r.get('upstream_response_content_length', 0) for r in self.receipts), 'source_object_bytes': int(self.obj['size']), 'source_generation': self.obj['generation'], 'max_bytes': self.max_bytes, 'budget_basis': 'sum of bounded upstream range lengths, including unread cancelled response bytes', 'measurement': 'HTTP body bytes actually read from upstream, includes read-ahead/cancelled requests; excludes HTTP/TLS overhead and unread socket buffers; not a billing measurement', 'requests': self.receipts, 'errors': self.errors}


def run(command, log):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1800)
    Path(log).write_text(result.stderr)
    require(result.returncode == 0, f'Command failed; see {log}')
    return result.stdout


def probe(path, log):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)], log))


def verify_current_source(obj):
    """Revalidate generation and size using metadata only, including cache hits."""
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/devstorage.read_only'])
    with AuthorizedSession(credentials) as session:
        api = f"https://storage.googleapis.com/storage/v1/b/{quote(obj['bucket'], safe='')}/o/{quote(obj['name'], safe='')}"
        response = session.get(api, timeout=45)
        response.raise_for_status()
        current = response.json()
    require(current['generation'] == obj['generation'] and current['size'] == obj['size'], 'Source generation/size changed since review packet')
    return current


def render(args, recipe, packet, validation):
    require(validation['renderable'], 'Rejected/unresolved candidates never render')
    obj = packet['gcs_object']
    codec = encoding.selected()
    identity = audit.digest({'recipe': recipe, 'generation': obj['generation'], 'encoding': codec['identity']})
    out = args.output / f"{recipe['candidate_id']}-{identity[:20]}"
    result_path, video = out / 'result.json', out / 'clip.mp4'
    current = verify_current_source(obj)
    if not any(os.environ.get(k) for k in ('SNIPPY_ENCODER_PROFILE', 'SNIPPY_FFMPEG', 'SNIPPY_ORIGINAL_RANGE_CACHE')):
        legacy_identity = audit.digest({'recipe': recipe, 'generation': obj['generation'], 'encoding': 'h264-crf18-slow-aac192-v1'})
        legacy = args.output / f"{recipe['candidate_id']}-{legacy_identity[:20]}"
        if (legacy / 'result.json').exists():
            cached = json.loads((legacy / 'result.json').read_text())
            require(cached['recipe_hash'] == legacy_identity, 'Cached legacy recipe identity changed')
            require((legacy / 'clip.mp4').exists() and sha(legacy / 'clip.mp4') == cached['output_sha256'], 'Cached legacy output missing or corrupt')
            input_root = args.output.parent / 'input'
            if (input_root / 'manifest.json').exists():
                from bounded_window_cache import open_window
                open_window(legacy, input_root)
            return cached
    if result_path.exists():
        result = json.loads(result_path.read_text())
        require(result.get('encoding_identity') == codec['identity'] and result['recipe_hash'] == identity, 'Cached encoding identity changed')
        require(video.exists() and sha(video) == result['output_sha256'], 'Cached output missing or corrupt')
        input_root = args.output.parent / 'input'
        if (input_root / 'manifest.json').exists():
            from bounded_window_cache import open_window
            open_window(out, input_root)
        return result
    import google.auth
    from google.auth.transport.requests import AuthorizedSession
    credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/devstorage.read_only'])
    session = AuthorizedSession(credentials)
    proxy = RangeProxy(session, obj, args.max_transfer_bytes or int(obj['size']), cache_root=os.environ.get('SNIPPY_ORIGINAL_RANGE_CACHE'))
    out.mkdir(parents=True, exist_ok=True)
    require(not (out / 'transfer.json').exists(), 'Previous attempt exists; inspect receipt before explicitly choosing a new output directory')
    audit.atomic(out / 'recipe.json', recipe)
    audit.atomic(out / 'source.json', current)
    parts = []
    started = time.monotonic()
    ffmpeg_version = run([codec['binary_path'], '-version'], out / 'ffmpeg-version.log').splitlines()[0]
    try:
        with proxy:
            try:
                container = inspect_proxy_mp4_extents(proxy.url, int(obj['size']))
            except SourceIntegrityError as exc:
                if exc.evidence:
                    exc.evidence['source_object'] = {key: str(obj[key]) for key in ('bucket', 'name', 'generation', 'size')}
                    audit.atomic(out / 'source-container.json', exc.evidence)
                raise
            container['source_object'] = {key: str(obj[key]) for key in ('bucket', 'name', 'generation', 'size')}
            audit.atomic(out / 'source-container.json', container)
            source_probe = probe(proxy.url, out / 'source-probe.log')
            audit.atomic(out / 'source-ffprobe.json', source_probe)
            for index, edit in enumerate(recipe['edits']):
                part = out / f'part-{index:03}.mp4'
                cmd = [codec['binary_path'], '-nostdin', '-hide_banner', '-v', 'error', '-y', '-ss', str(edit['start_seconds']), '-i', proxy.url, '-t', str(edit['end_seconds'] - edit['start_seconds']), '-map', '0:v:0', '-map', '0:a:0', '-map_chapters', '-1', '-sn', '-dn', *encoding.output_args(codec), str(part)]
                run(cmd, out / f'part-{index:03}.log')
                parts.append(part)
        require(not proxy.errors, 'Range transfer errors; inspect transfer.json')
    finally:
        receipt = proxy.report()
        receipt['elapsed_seconds'] = time.monotonic() - started
        receipt['ffmpeg_version'] = ffmpeg_version
        audit.atomic(out / 'transfer.json', receipt)
        session.close()
    if len(parts) == 1:
        parts[0].replace(video)
    else:
        listing = out / 'concat.txt'
        listing.write_text(''.join(f"file '{p.name}'\n" for p in parts))
        run(['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', str(listing), '-c', 'copy', '-movflags', '+faststart', str(video)], out / 'concat.log')
    qa = probe(video, out / 'output-probe.log')
    streams = qa['streams']
    v = next((s for s in streams if s['codec_type'] == 'video'), None)
    a = next((s for s in streams if s['codec_type'] == 'audio'), None)
    sv = next((s for s in source_probe['streams'] if s['codec_type'] == 'video'), None)
    checks = {'video': v is not None, 'audio': a is not None, 'duration': abs(float(qa['format']['duration']) - validation['duration_seconds']) < 0.3, 'native_dimensions': v is not None and sv is not None and (v['width'], v['height']) == (sv['width'], sv['height'])}
    checks['native_fps'] = v is not None and sv is not None and encoding.native_fps(v, sv)
    run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-i', str(video), '-f', 'null', '-'], out / 'decode.log')
    checks['full_decode'] = True
    audit.atomic(out / 'qa.json', {'checks': checks, 'ffprobe': qa, 'human_picture_and_dialogue_review': 'pending'})
    require(all(checks.values()), 'Output QA failed')
    result = {'recipe_hash': identity, 'candidate_id': recipe['candidate_id'], 'provider': 'astra', 'source_generation': obj['generation'], 'source_input_hash': recipe['source_input_hash'], 'clip_path': str(video.resolve()), 'output_sha256': sha(video), 'duration_seconds': float(qa['format']['duration']), 'output_bytes': video.stat().st_size, 'elapsed_seconds': time.monotonic() - started, 'ffmpeg_version': ffmpeg_version, 'transfer': receipt, 'automated_qa': checks, 'human_picture_and_dialogue_review': 'pending', 'uploaded': False, 'database_written': False, 'created_at': audit.now()}
    result.update(encoding=codec, encoding_identity=codec['identity'])
    audit.atomic(result_path, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['validate', 'render'])
    parser.add_argument('--recipe', required=True, type=Path)
    parser.add_argument('--packets', type=Path, default=Path('.context/astra-clips/candidates'))
    parser.add_argument('--audit-run', type=Path, default=Path('.context/relevance'))
    parser.add_argument('--culled', type=Path, default=Path('.context/cull-20260930/decisions.json'))
    parser.add_argument('--output', type=Path, default=Path('.context/astra-clips/rendered'))
    parser.add_argument('--max-transfer-bytes', type=int)
    args = parser.parse_args()
    require(args.max_transfer_bytes is None or args.max_transfer_bytes > 0, 'Transfer budget must be positive')
    recipe, packet, validation = load_inputs(args)
    result = render(args, recipe, packet, validation) if args.command == 'render' else validation
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
