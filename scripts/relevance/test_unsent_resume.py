import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import luna_batch_qa as luna


class UnsentResumeTests(unittest.TestCase):
    def fixture(self, root):
        body = {'model': 'gpt-6-luna', 'instructions': 'unchanged'}
        out = root / luna.audit.digest(body)
        prior = {'status': 'cancelled_before_dispatch', 'role': 'finalizer',
                 'attempt': 1, 'dispatched': False, 'charge_unknown': False}
        luna.audit.atomic(out / 'call-state.json', prior)
        base = {'request_hash': out.name, 'role': 'finalizer', 'attempt': 1, 'pid': 55}
        events = [{**base, 'event': 'request_start'}, {**base, **prior, 'event': 'request_end',
                  'http_status': None, 'response_id': None}]
        (out / 'transport-events.jsonl').write_text('\n'.join(json.dumps(e) for e in events) + '\n')
        return body, out, prior

    def test_proven_unsent_intent_dispatches_once_and_keeps_original_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            body, out, prior = self.fixture(Path(tmp))
            original = (out / 'call-state.json').read_bytes()
            response = Mock(status_code=200)
            response.json.return_value = {'id': 'resp_resume'}
            with patch.object(luna, 'build_request', return_value=body), patch.object(luna, 'bind_request'), \
                 patch.object(luna.audit, 'api_key', return_value='test'), \
                 patch.object(luna, 'normalize', return_value={'decisions': []}), \
                 patch('requests.post', return_value=response) as post:
                luna.review_packages([], Path(tmp))
                luna.review_packages([], Path(tmp))
            self.assertEqual(post.call_count, 1)
            self.assertEqual(next(out.glob('cancelled-intent-*.json')).read_bytes(), original)
            self.assertEqual(luna.read(out / 'call-state.json')['status'], 'response_saved')

    def test_ambiguous_states_never_become_retryable(self):
        for status in ('started', 'unknown_charge', 'rejected', 'rate_limited'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                _, out, prior = self.fixture(Path(tmp))
                luna.audit.atomic(out / 'call-state.json', {**prior, 'status': status})
                with self.assertRaisesRegex(ValueError, 'Prior API call'):
                    luna.preserve_cancelled_intent(out / 'call-state.json', 'finalizer')

    def test_unpaired_or_dispatched_event_is_rejected(self):
        for mutation in ('dispatched', 'request_hash', 'attempt'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                _, out, _ = self.fixture(Path(tmp))
                path = out / 'transport-events.jsonl'
                events = [json.loads(line) for line in path.read_text().splitlines()]
                events[-1][mutation] = True if mutation == 'dispatched' else 'changed'
                path.write_text('\n'.join(json.dumps(e) for e in events))
                with self.assertRaisesRegex(ValueError, 'transport evidence mismatch'):
                    luna.preserve_cancelled_intent(out / 'call-state.json', 'finalizer')


if __name__ == '__main__':
    unittest.main()
