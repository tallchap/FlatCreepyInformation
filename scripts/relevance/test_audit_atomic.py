"""Windows sharing tests for durable receipt/status replacement."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import audit
import supervise_continuation as supervisor


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'status.json'
        self.path.write_text('{"old": true}', encoding='utf-8')

    @unittest.skipUnless(os.name == 'nt', 'Windows file sharing regression')
    def test_real_reader_denying_delete_releases_after_point_one_seconds(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        for writer in (audit.atomic, supervisor.atomic):
            with self.subTest(writer=writer.__module__):
                handle = kernel.CreateFileW(str(self.path), 0x80000000, 3, None, 3, 0x80, None)
                self.assertNotEqual(ctypes.c_void_p(-1).value, handle)
                timer = threading.Timer(0.1, lambda: kernel.CloseHandle(handle))
                timer.start()
                started = time.monotonic()
                try:
                    writer(self.path, {'new': writer.__module__})
                finally:
                    timer.join()
                elapsed = time.monotonic() - started
                self.assertGreaterEqual(elapsed, 0.08)
                self.assertLess(elapsed, 2)
                self.assertEqual({'new': writer.__module__}, json.loads(self.path.read_text()))
                self.assertFalse(list(self.path.parent.glob('*.tmp')))

    @unittest.skipUnless(os.name == 'nt', 'Windows retry policy')
    def test_permanent_sharing_failure_is_bounded_preserves_old_file(self):
        for writer in (audit.atomic, supervisor.atomic):
            with self.subTest(writer=writer.__module__):
                clock = [0.0]
                error = PermissionError('held reader')
                error.winerror = 5
                before = self.path.read_bytes()
                with patch.object(audit.os, 'replace', side_effect=error) as replace, \
                        patch.object(audit.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(audit.time, 'sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
                    with self.assertRaises(PermissionError):
                        writer(self.path, {'must_not_replace_old': True})
                self.assertLessEqual(clock[0], 3.001)
                self.assertGreaterEqual(clock[0], 3)
                self.assertLessEqual(replace.call_count, 125)
                self.assertEqual(before, self.path.read_bytes())
                self.assertFalse(list(self.path.parent.glob('*.tmp')))

    @unittest.skipUnless(os.name == 'nt', 'Windows retry policy')
    def test_exact_three_windows_sharing_errors_retry_same_payload(self):
        for code in (5, 32, 33):
            with self.subTest(winerror=code):
                error = PermissionError('brief sharing error')
                error.winerror = code
                original_replace = os.replace
                paths = []
                def replacement(source, destination):
                    paths.append((source, destination, Path(source).read_bytes()))
                    if len(paths) < 3:
                        raise error
                    original_replace(source, destination)
                with patch.object(audit.os, 'replace', side_effect=replacement), patch.object(audit.time, 'sleep'):
                    audit.atomic(self.path, {'exact': code})
                self.assertEqual(3, len(paths))
                self.assertEqual(paths[0], paths[1])
                self.assertEqual(paths[1], paths[2])
                self.assertEqual({'exact': code}, json.loads(self.path.read_text()))

    def test_nonsharing_error_is_not_retried(self):
        error = OSError('invalid parameter')
        error.winerror = 87
        with patch.object(audit.os, 'replace', side_effect=error) as replace, patch.object(audit.time, 'sleep') as sleep:
            with self.assertRaises(OSError):
                audit.atomic(self.path, {'new': True})
        self.assertEqual(1, replace.call_count)
        sleep.assert_not_called()
        self.assertEqual({'old': True}, json.loads(self.path.read_text()))


if __name__ == '__main__':
    unittest.main()
