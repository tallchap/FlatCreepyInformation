import copy
import io
import json
from pathlib import Path
import struct
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import Mock
from urllib.request import Request, urlopen

import audit
from process_astra import RangeProxy, SourceIntegrityError, inspect_mp4_extents, validate


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.source = {'video_id': 'abcdefghijk', 'transcript': '[0] all\n[10] words\n[20] here\n[30] next'}
        self.source['input_hash'] = audit.digest(self.source)
        import hashlib
        self.packet = {'candidate_id': 'abcdefghijk', 'lane': 'eligible', 'source_input_hash': self.source['input_hash'], 'full_transcript_sha256': hashlib.sha256(self.source['transcript'].encode()).hexdigest(), 'source_duration_seconds': 40, 'context_start_seconds': 0, 'context_end_seconds': 40, 'luna_proposal': {'start_seconds': 0, 'end_seconds': 20}, 'gcs_object': {'bucket': 'test', 'name': 'videos/abcdefghijk.mp4', 'generation': '1', 'size': '123'}}
        self.recipe = {'schema_version': 'snippy-astra-edit-v1', 'candidate_id': 'abcdefghijk', 'source_input_hash': self.source['input_hash'], 'decision': 'approve', 'clip_worthy': True, 'title': 'Title', 'speaker': 'Speaker', 'reason': 'Reason', 'edit_notes': '', 'edits': [{'start_seconds': 0, 'end_seconds': 20, 'transcript': 'all words'}]}

    def check(self):
        return validate(self.recipe, self.packet, self.source, set())

    def test_valid(self):
        self.assertEqual(self.check(), {'renderable': True, 'duration_seconds': 20})

    def test_end_exclusive_verbatim(self):
        for bad in ('all', 'all words here', 'All words', 'all improved words'):
            with self.subTest(bad=bad):
                self.recipe['edits'][0]['transcript'] = bad
                with self.assertRaisesRegex(ValueError, 'ALL verbatim'):
                    self.check()

    def test_membership_hash_and_cull(self):
        with self.assertRaisesRegex(ValueError, 'Culled'):
            validate(self.recipe, self.packet, self.source, {'abcdefghijk'})
        self.recipe['candidate_id'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'membership'):
            self.check()
        self.recipe['candidate_id'] = 'abcdefghijk'
        self.recipe['source_input_hash'] = 'stale'
        with self.assertRaisesRegex(ValueError, 'source_input_hash'):
            self.check()

    def test_source_tamper(self):
        self.source['transcript'] += ' altered'
        with self.assertRaisesRegex(ValueError, 'snapshot hash'):
            self.check()

    def test_rejection_gate(self):
        for decision in ('reject', 'needs_context'):
            self.recipe.update(decision=decision, clip_worthy=False, edits=[])
            self.assertFalse(self.check()['renderable'])
            self.recipe['clip_worthy'] = True
            with self.assertRaises(ValueError):
                self.check()

    def test_invalid_ranges(self):
        for start, end in [(False, 20), (float('nan'), 20), (-10, 20), (0, 50), (0, 10), (1, 20), (20, 0)]:
            with self.subTest(start=start, end=end):
                self.recipe['edits'][0].update(start_seconds=start, end_seconds=end)
                with self.assertRaises(ValueError):
                    self.check()

    def test_revise_and_multiple_edits(self):
        self.recipe.update(decision='revise', edit_notes='Omit middle thought', edits=[{'start_seconds': 0, 'end_seconds': 10, 'transcript': 'all'}, {'start_seconds': 20, 'end_seconds': 30, 'transcript': 'here'}])
        self.assertTrue(self.check()['renderable'])
        self.recipe['edits'].reverse()
        with self.assertRaisesRegex(ValueError, 'sorted'):
            self.check()
        self.recipe['edits'].reverse()
        self.recipe['edits'][1]['start_seconds'] = 0
        with self.assertRaisesRegex(ValueError, 'nonoverlapping'):
            self.check()

    def test_changed_approve_and_missing_source(self):
        self.recipe['edits'][0].update(end_seconds=30, transcript='all words here')
        with self.assertRaisesRegex(ValueError, 'require revise'):
            self.check()
        self.recipe['decision'] = 'revise'
        self.packet['gcs_object'] = None
        with self.assertRaisesRegex(ValueError, 'source object'):
            self.check()


class FakeRaw(io.BytesIO):
    def read(self, amount=-1, decode_content=False):
        return super().read(amount)


class FakeResponse:
    def __init__(self, data, start, end, status=206):
        self.status_code = status
        self.headers = {'Content-Length': str(end - start + 1), 'Content-Range': f'bytes {start}-{end}/{len(data)}'}
        self.raw = FakeRaw(data[start:end + 1])
    def close(self):
        self.raw.close()


class FakeSession:
    def __init__(self, data, status=206):
        self.data, self.status, self.calls = data, status, []
    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        lo, hi = kwargs['headers']['Range'][6:].split('-')
        return FakeResponse(self.data, int(lo), int(hi) if hi else len(self.data) - 1, self.status)


class ContainerIntegrityTests(unittest.TestCase):
    @staticmethod
    def box(kind, payload=b'', declared_size=None):
        size = 8 + len(payload) if declared_size is None else declared_size
        return struct.pack('>I4s', size, kind) + payload

    @staticmethod
    def inspect(data):
        return inspect_mp4_extents(
            len(data), lambda start, end: data[start:end + 1])

    def test_valid_top_level_boxes_cover_exact_object(self):
        data = self.box(b'ftyp', b'isom') + self.box(b'moov') + self.box(b'mdat', b'frames')
        report = self.inspect(data)
        self.assertTrue(report['applicable'] and report['complete'])
        self.assertEqual([box['type'] for box in report['boxes']], ['ftyp', 'moov', 'mdat'])
        self.assertEqual(report['boxes'][-1]['declared_end'], len(data))

    def test_declared_mdat_past_immutable_object_is_typed_source_corruption(self):
        data = self.box(b'ftyp') + self.box(b'moov') + self.box(b'mdat', declared_size=1000)
        with self.assertRaisesRegex(SourceIntegrityError, 'truncated') as raised:
            self.inspect(data)
        evidence = raised.exception.evidence
        self.assertEqual(evidence['error'], 'declared_box_past_object_end')
        self.assertEqual(evidence['boxes'][-1]['type'], 'mdat')
        self.assertEqual(evidence['boxes'][-1]['missing_bytes'], 992)

    def test_non_isobmff_payload_is_not_misclassified_from_mp4_suffix(self):
        data = b'not an ISO base media file despite its external name'
        report = self.inspect(data)
        self.assertFalse(report['applicable'])
        self.assertIsNone(report['complete'])
        self.assertEqual(report['not_applicable_reason'], 'no_isobmff_ftyp_header')

    def test_size_zero_and_64_bit_extended_boxes_are_supported(self):
        ftyp = self.box(b'ftyp')
        extended = struct.pack('>I4sQ', 1, b'moov', 16)
        to_eof = struct.pack('>I4s', 0, b'mdat') + b'frames'
        report = self.inspect(ftyp + extended + to_eof)
        self.assertTrue(report['complete'])
        self.assertEqual(report['boxes'][1]['header_size'], 16)
        self.assertEqual(report['boxes'][-1]['declared_end'], report['object_size'])

    def test_many_legal_top_level_boxes_are_inconclusive_not_corrupt(self):
        data = self.box(b'ftyp') + self.box(b'free') * 4096 + self.box(b'mdat')
        report = self.inspect(data)
        self.assertTrue(report['applicable'])
        self.assertIsNone(report['complete'])
        self.assertIsNone(report['error'])
        self.assertEqual(report['inspection_inconclusive_reason'], 'top_level_box_limit')
        self.assertEqual(report['next_offset'], 8 * 4096)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required')
    def test_truncated_faststart_mp4_fails_extent_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                            'testsrc2=size=64x64:rate=5', '-t', '1', '-c:v',
                            'libx264', '-movflags', '+faststart', str(source)],
                           check=True, capture_output=True)
            data = source.read_bytes()
            self.assertTrue(self.inspect(data)['complete'])
            with self.assertRaisesRegex(SourceIntegrityError, 'truncated'):
                self.inspect(data[:-64])


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.data = b'x' * 100000
        self.obj = {'bucket': 'test', 'name': 'videos/a.mp4', 'generation': '123', 'size': str(len(self.data))}

    def test_ranges_are_forwarded_pinned_and_measured(self):
        session = FakeSession(self.data)
        proxy = RangeProxy(session, self.obj, len(self.data))
        with proxy:
            with urlopen(Request(proxy.url, headers={'Range': 'bytes=123-999'})) as response:
                self.assertEqual(response.read(), self.data[123:1000])
            with urlopen(Request(proxy.url, method='HEAD')) as response:
                self.assertEqual(response.headers['Content-Length'], str(len(self.data)))
        self.assertEqual(proxy.bytes_read, 877)
        self.assertEqual(proxy.receipts[0]['content_range'], 'bytes 123-999/100000')
        self.assertEqual(session.calls[0][1]['params']['ifGenerationMatch'], '123')
        self.assertEqual(session.calls[0][1]['params']['generation'], '123')
        self.assertEqual(len(session.calls), 1)

    def test_transfer_budget_stops_without_retry(self):
        session = FakeSession(self.data)
        proxy = RangeProxy(session, self.obj, 100)
        with proxy:
            with urlopen(proxy.url) as response:
                try:
                    response.read()
                except Exception:
                    pass
        self.assertEqual(proxy.bytes_read, 100)
        self.assertEqual(len(session.calls), 1)
        self.assertTrue(any('budget exhausted' in x for x in proxy.errors))

    def test_pages_reassemble_exact_nonzero_range_and_budget(self):
        data = bytes(range(256)) * 100
        obj = dict(self.obj, size=str(len(data)))
        session = FakeSession(data)
        proxy = RangeProxy(session, obj, 5001, page_bytes=1024)
        with proxy:
            with urlopen(Request(proxy.url, headers={'Range': 'bytes=731-5731'})) as response:
                self.assertEqual(response.headers['Content-Range'], 'bytes 731-5731/25600')
                self.assertEqual(response.read(), data[731:5732])
        self.assertFalse(proxy.errors)
        self.assertEqual([call[1]['headers']['Range'] for call in session.calls], ['bytes=731-1754', 'bytes=1755-2778', 'bytes=2779-3802', 'bytes=3803-4826', 'bytes=4827-5731'])
        self.assertEqual(proxy.bytes_requested, 5001)
        self.assertEqual(proxy.report()['conservative_response_bytes_upper_bound'], 5001)
        self.assertEqual(proxy.bytes_read, 5001)

    def test_open_ended_downstream_is_bounded_upstream(self):
        session = FakeSession(self.data)
        proxy = RangeProxy(session, self.obj, len(self.data), page_bytes=32768)
        with proxy:
            with urlopen(proxy.url) as response:
                self.assertEqual(response.read(), self.data)
        self.assertFalse(proxy.errors)
        self.assertEqual(len(session.calls), 4)
        self.assertTrue(all(call[1]['headers']['Range'].split('-')[1] for call in session.calls))
        self.assertEqual(proxy.bytes_requested, len(self.data))

    def test_cancelled_response_overfetch_is_bounded_by_one_page(self):
        import socket
        data = b'x' * 20000000
        session = FakeSession(data)
        proxy = RangeProxy(session, dict(self.obj, size=str(len(data))), len(data), page_bytes=65536)
        with proxy:
            sock = socket.create_connection(('127.0.0.1', proxy.server.server_port))
            sock.sendall(f'GET {proxy.path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'.encode())
            sock.recv(100)
            sock.close()
        self.assertTrue(proxy.receipts[0]['cancelled'])
        self.assertGreater(proxy.bytes_requested, 0)
        self.assertLessEqual(proxy.bytes_requested - proxy.bytes_read, 65536)
        self.assertLess(proxy.bytes_requested, len(data))
        self.assertEqual(proxy.report()['conservative_response_bytes_upper_bound'], proxy.bytes_requested)

    def test_bad_range_metadata_fails_before_body_read(self):
        class WrongSession(FakeSession):
            def get(self, url, **kwargs):
                response = super().get(url, **kwargs)
                response.headers['Content-Range'] = 'bytes 1-2/3'
                return response
        proxy = RangeProxy(WrongSession(self.data), self.obj, len(self.data), page_bytes=1024)
        with proxy:
            with self.assertRaises(Exception):
                urlopen(proxy.url)
        self.assertEqual(proxy.bytes_read, 0)
        self.assertTrue(any('mismatched Content-Range' in e for e in proxy.errors))

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_real_ffmpeg_range_seek_keeps_picture_audio_and_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.mp4', Path(directory) / 'clip.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '40', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', str(source)], check=True, capture_output=True)
            data = source.read_bytes()
            obj = dict(self.obj, size=str(len(data)))
            proxy = RangeProxy(FakeSession(data), obj, len(data) * 2, page_bytes=8192)
            with proxy:
                subprocess.run(['ffmpeg', '-v', 'error', '-ss', '10', '-i', proxy.url, '-t', '20', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-c:a', 'aac', str(output)], check=True, capture_output=True)
            info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(output)]))
            self.assertLess(abs(float(info['format']['duration']) - 20), 0.2)
            self.assertEqual({s['codec_type'] for s in info['streams']}, {'video', 'audio'})
            self.assertEqual(info['streams'][0]['width'], 160)
            self.assertGreater(proxy.bytes_read, 0)
            self.assertFalse(proxy.errors)
            self.assertGreater(sum(len(r['pages']) for r in proxy.receipts), 1)
            self.assertTrue(all(p['requested_bytes'] <= 8192 for r in proxy.receipts for p in r['pages']))

    def test_ignored_range_never_downloads_body(self):
        session = FakeSession(self.data, status=200)
        proxy = RangeProxy(session, self.obj, len(self.data))
        with proxy:
            with self.assertRaises(Exception):
                urlopen(proxy.url)
        self.assertEqual(proxy.bytes_read, 0)
        self.assertTrue(proxy.errors)

    def direct_handler(self, session=None):
        """Exercise the real handler with controlled local socket failures."""
        session = session or FakeSession(self.data)
        proxy = RangeProxy(session, self.obj, len(self.data), page_bytes=32768)
        self.addCleanup(proxy.server.server_close)
        handler = proxy.server.RequestHandlerClass.__new__(proxy.server.RequestHandlerClass)
        handler.path, handler.headers = proxy.path, {'Range': 'bytes=0-'}
        handler.connection, handler.wfile = Mock(), Mock()
        handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
        return proxy, handler, session

    def test_local_windows_abort_stops_transfer_without_upstream_failure_or_retry(self):
        error = OSError('Native local socket abort')
        error.winerror = 10053
        proxy, handler, session = self.direct_handler()
        handler.wfile.write.side_effect = error
        handler.do_GET()
        receipt = proxy.receipts[0]
        self.assertTrue(receipt['cancelled'])
        self.assertEqual(receipt['downstream_disconnect']['operation'], 'body')
        self.assertEqual(receipt['downstream_disconnect']['winerror'], 10053)
        self.assertEqual(proxy.errors, [])
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(proxy.bytes_read, 16384)
        self.assertEqual(proxy.bytes_requested, 32768)
        self.assertEqual(proxy.report()['conservative_response_bytes_upper_bound'], 32768)

    def test_local_header_and_flush_aborts_are_cancellations(self):
        for operation in ('headers', 'flush'):
            with self.subTest(operation=operation):
                proxy, handler, session = self.direct_handler()
                writer = handler.end_headers if operation == 'headers' else handler.wfile.flush
                writer.side_effect = ConnectionAbortedError('Local client closed')
                handler.do_GET()
                self.assertTrue(proxy.receipts[0]['cancelled'])
                self.assertEqual(proxy.receipts[0]['downstream_disconnect']['operation'], operation)
                self.assertEqual(proxy.errors, [])
                self.assertEqual(proxy.bytes_read, 0 if operation == 'headers' else len(self.data))

    def test_upstream_connection_aborts_and_resets_remain_failures(self):
        for error_type in (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            for location in ('request', 'read'):
                with self.subTest(error_type=error_type.__name__, location=location):
                    session = FakeSession(self.data)
                    if location == 'request':
                        session.get = Mock(side_effect=error_type('Upstream failed'))
                    else:
                        original = session.get
                        def get(*args, **kwargs):
                            response = original(*args, **kwargs)
                            response.raw.read = Mock(side_effect=error_type('Upstream failed'))
                            return response
                        session.get = get
                    proxy, handler, _ = self.direct_handler(session)
                    handler.do_GET()
                    self.assertFalse(proxy.receipts[0]['cancelled'])
                    self.assertEqual(proxy.errors, ['Upstream failed'])
                    self.assertEqual(proxy.bytes_read, 0)
                    self.assertNotIn('downstream_disconnect', proxy.receipts[0])

    def test_other_local_write_errors_still_fail_closed(self):
        proxy, handler, _ = self.direct_handler()
        handler.wfile.write.side_effect = TimeoutError('Local write timed out')
        handler.do_GET()
        self.assertFalse(proxy.receipts[0]['cancelled'])
        self.assertEqual(proxy.errors, ['Local write timed out'])


if __name__ == '__main__':
    unittest.main()
