import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from urllib.request import Request, urlopen

import range_cache as cache
from process_astra import RangeProxy
from test_process_astra import FakeSession, FakeRaw


class RangeCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = bytes(range(256)) * 500
        self.obj = {'bucket': 'synthetic', 'name': 'original.mp4', 'generation': '123', 'size': str(len(self.data))}

    def cached(self):
        return cache.OriginalRangeCache(self.root, self.obj)

    def test_exact_cold_pages_then_warm_zero_upstream_identical_body(self):
        session = FakeSession(self.data)
        with RangeProxy(session, self.obj, len(self.data), page_bytes=8192, cache_root=self.root) as cold:
            with urlopen(Request(cold.url, headers={'Range': 'bytes=731-50731'})) as response:
                first = response.read()
        warm_session = FakeSession(self.data)
        with RangeProxy(warm_session, self.obj, 1, page_bytes=8192, cache_root=self.root) as warm:
            with urlopen(Request(warm.url, headers={'Range': 'bytes=731-50731'})) as response:
                second = response.read()
        self.assertEqual(first, self.data[731:50732])
        self.assertEqual(first, second)
        self.assertTrue(all(int(call[1]['headers']['Range'].split('-')[1]) - int(call[1]['headers']['Range'][6:].split('-')[0]) + 1 <= 8192 for call in session.calls))
        self.assertEqual(warm_session.calls, [])
        report = warm.report()
        self.assertEqual(report['upstream_body_bytes_read'], 0)
        self.assertEqual(report['upstream_requested_bytes'], 0)
        self.assertEqual(report['conservative_response_bytes_upper_bound'], 0)
        self.assertEqual(report['original_cache_body_bytes_read'], len(first))
        self.assertGreater(report['original_cache_page_hits'], 0)
        self.assertEqual([p for r in report['requests'] for p in r['pages'] if not p['cache_hit']], [])

    def test_subset_adjacent_and_overlapping_coverage_with_gaps(self):
        c = self.cached()
        c.save(10, 29, self.data[10:30])
        c.save(30, 49, self.data[30:50])
        self.assertEqual(c.load(15, 44), self.data[15:45])
        self.assertEqual(c.covered_range_hits, 1)
        c.save(40, 59, self.data[40:60])
        self.assertEqual(c.load(12, 57), self.data[12:58])
        self.assertIsNone(c.load(9, 57))
        c.save(70, 79, self.data[70:80])
        self.assertIsNone(c.load(50, 75))
        with self.assertRaisesRegex(ValueError, 'overlapping bytes'):
            c.save(55, 69, b'wrong-contents!')

    def test_generation_isolates_and_receipt_or_body_drift_fails(self):
        c = self.cached(); c.save(0, 99, self.data[:100])
        other = cache.OriginalRangeCache(self.root, {**self.obj, 'generation': '124'})
        self.assertIsNone(other.load(0, 99))
        body, receipt = c.paths(0, 99)
        saved = receipt.read_bytes()
        raw = json.loads(saved); raw['object']['generation'] = '124'
        receipt.write_text(json.dumps(raw), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'drift'):
            c.load(10, 50)
        receipt.write_bytes(saved)
        body.write_bytes(b'z' * 100)
        with self.assertRaisesRegex(ValueError, 'drift'):
            c.load(10, 50)

    def test_corrupt_overlapping_receipt_fails_even_when_other_page_covers_request(self):
        c = self.cached(); c.save(0, 99, self.data[:100]); c.save(90, 109, self.data[90:110])
        body, _ = c.paths(90, 109); body.write_bytes(b'x' * 20)
        with self.assertRaisesRegex(ValueError, 'drift'):
            c.load(80, 95)

    def handler(self, session):
        proxy = RangeProxy(session, self.obj, len(self.data), page_bytes=32768, cache_root=self.root)
        self.addCleanup(proxy.server.server_close)
        handler = proxy.server.RequestHandlerClass.__new__(proxy.server.RequestHandlerClass)
        handler.path, handler.headers = proxy.path, {'Range': 'bytes=0-32767'}
        handler.connection, handler.wfile = Mock(), Mock()
        handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
        return proxy, handler

    def test_partial_downstream_disconnect_and_incomplete_upstream_never_cache(self):
        for scenario in ('downstream', 'upstream'):
            with self.subTest(scenario=scenario):
                session = FakeSession(self.data)
                if scenario == 'upstream':
                    original = session.get
                    def get(*args, **kwargs):
                        response = original(*args, **kwargs)
                        response.raw = FakeRaw(self.data[:100])
                        return response
                    session.get = get
                proxy, handler = self.handler(session)
                if scenario == 'downstream':
                    handler.wfile.write.side_effect = ConnectionAbortedError('fixture client closed')
                handler.do_GET()
                self.assertIsNone(self.cached().load(0, 32767))
                self.assertFalse(list(self.cached().root.glob('*.json')))
                self.assertEqual(len(session.calls), 1)
                self.assertEqual(proxy.receipts[0]['cancelled'], scenario == 'downstream')
                self.assertEqual(bool(proxy.errors), scenario == 'upstream')

    def test_wrong_upstream_generation_is_not_cached(self):
        session = FakeSession(self.data); original = session.get
        def get(*args, **kwargs):
            response = original(*args, **kwargs)
            response.headers['x-goog-generation'] = 'changed'
            return response
        session.get = get
        proxy, handler = self.handler(session); handler.do_GET()
        self.assertEqual(proxy.bytes_read, 0)
        self.assertTrue(any('generation changed' in error for error in proxy.errors))
        self.assertIsNone(self.cached().load(0, 32767))

    def test_incomplete_save_and_oversized_range_rejected(self):
        c = self.cached()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            c.save(0, 99, b'partial')
        large = cache.OriginalRangeCache(self.root, {**self.obj, 'size': str(2*1024*1024)})
        with self.assertRaisesRegex(ValueError, 'bounded pages'):
            large.load(0, 1024*1024)


if __name__ == '__main__':
    unittest.main()
