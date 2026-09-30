import tempfile
import json
import time
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import requests
import luna_batch_qa as luna


class TransportTests(unittest.TestCase):
    def invoke(self, root, responses):
        body = {'model': 'gpt-6-luna', 'instructions': 'unchanged'}
        patches = [patch.object(luna, 'build_request', return_value=body),
                   patch.object(luna, 'bind_request'),
                   patch.object(luna.audit, 'api_key', return_value='private-test-value'),
                   patch.object(luna, 'normalize', return_value={'decisions': []})]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        with patch('requests.post', side_effect=responses) as post, patch.object(luna.time, 'sleep') as sleep:
            result = luna.review_packages([], root)
        return result, post, sleep

    def test_explicit_429_respects_retry_after_then_saves_response(self):
        limited = Mock(status_code=429, headers={'Retry-After': '7'})
        good = Mock(status_code=200)
        good.json.return_value = {'id': 'resp_test'}
        with tempfile.TemporaryDirectory() as tmp:
            _, post, sleep = self.invoke(Path(tmp), [limited, good])
            self.assertEqual(post.call_count, 2)
            sleep.assert_called_once_with(7)
            state = luna.read(next(Path(tmp).glob('*/call-state.json')))
            self.assertEqual(state['status'], 'response_saved')
            events = [json.loads(line) for line in next(Path(tmp).glob('*/transport-events.jsonl')).read_text().splitlines()]
            self.assertEqual([event['event'] for event in events], ['request_start', 'request_end'] * 2)
            self.assertEqual(events[1]['http_status'], 429)
            self.assertEqual(events[1]['retry_after_seconds'], 7)
            self.assertEqual(events[-1]['response_id'], 'resp_test')
            self.assertEqual(events[-1]['model'], 'gpt-6-luna')
            self.assertGreaterEqual(events[-1]['elapsed_seconds'], 0)
            self.assertLessEqual(events[-1]['started_at'], events[-1]['ended_at'])

    def test_ambiguous_timeout_is_never_automatically_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(requests.Timeout):
                self.invoke(Path(tmp), [requests.Timeout('network completion unknown')])
            state = luna.read(next(Path(tmp).glob('*/call-state.json')))
            self.assertEqual(state['status'], 'unknown_charge')
            events_path = next(Path(tmp).glob('*/transport-events.jsonl'))
            events = [json.loads(line) for line in events_path.read_text().splitlines()]
            self.assertEqual(len(events), 2)
            self.assertEqual(events[-1]['status'], 'unknown_charge')
            self.assertEqual(events[-1]['error_type'], 'Timeout')
            with self.assertRaisesRegex(ValueError, 'Prior API call'):
                self.invoke(Path(tmp), [])
            self.assertEqual(len(events_path.read_text().splitlines()), 2)

    def test_rate_limit_attempts_are_bounded(self):
        limited = Mock(status_code=429, headers={'Retry-After': '0'})
        limited.raise_for_status.side_effect = requests.HTTPError('429')
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(requests.HTTPError):
                self.invoke(Path(tmp), [limited, limited, limited])
            state = luna.read(next(Path(tmp).glob('*/call-state.json')))
            self.assertEqual(state['attempt'], 3)
            self.assertEqual(state['status'], 'rejected')

    def test_http_interval_excludes_slow_json_parsing(self):
        response = Mock(status_code=200)
        real_sleep = time.sleep

        def slow_json():
            real_sleep(.1)
            return {'id': 'resp_slow_parse'}
        response.json.side_effect = slow_json
        with tempfile.TemporaryDirectory() as tmp:
            self.invoke(Path(tmp), [response])
            events = [json.loads(line) for line in next(Path(tmp).glob('*/transport-events.jsonl')).read_text().splitlines()]
            self.assertLess(events[-1]['elapsed_seconds'], .05)
            self.assertLess(events[-1]['ended_at'], events[-1]['timestamp'])
            self.assertEqual(events[-1]['interval_kind'], 'client_http_request_lifetime')


if __name__ == '__main__':
    unittest.main()
