import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

import technical_audio_evidence as audio


class AudioEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.media = self.root / 'clip.mp4'
        self.media.write_bytes(b'fixture-media')
        self.out = self.root / 'attempt'
        self.response = {'choices': [{'finish_reason': 'stop', 'message': {
            'content': json.dumps(dict.fromkeys(audio.FIELDS, 'fixture'))}}], 'usage': {}}

    def extract(self, media, target):
        target.write_bytes(b'fixture-audio')

    def test_receipt_precedes_request_and_repeat_is_blocked(self):
        def sender(body):
            receipt = json.loads((self.out / 'request-receipt.json').read_text())
            self.assertEqual(receipt['status'], 'in_flight')
            self.assertFalse(receipt['approved_for_publication'])
            self.assertEqual(json.loads(body)['model'], audio.MODEL)
            return self.response, 'request-1'
        sender = Mock(side_effect=sender)
        result = audio.run(self.media, self.out, sender, self.extract)
        self.assertEqual(result['status'], 'evidence_ready')
        with self.assertRaises(FileExistsError):
            audio.run(self.media, self.out, sender, self.extract)
        sender.assert_called_once()

    def test_ambiguous_network_failure_is_preserved_and_cannot_replay(self):
        sender = Mock(side_effect=TimeoutError('response unknown'))
        with self.assertRaises(TimeoutError):
            audio.run(self.media, self.out, sender, self.extract)
        failure = json.loads((self.out / 'failure.json').read_text())
        self.assertEqual(failure['status'], 'charge_unknown')
        with self.assertRaises(FileExistsError):
            audio.run(self.media, self.out, sender, self.extract)
        sender.assert_called_once()

    def test_malformed_response_preserved_before_failure(self):
        self.response['choices'][0]['message']['content'] = 'not JSON'
        with self.assertRaises(ValueError):
            audio.run(self.media, self.out, lambda _: (self.response, 'req'), self.extract)
        self.assertTrue((self.out / 'response.json').exists())
        self.assertFalse((self.out / 'evidence.json').exists())

    def test_changed_media_cannot_produce_ready_evidence(self):
        def sender(_):
            self.media.write_bytes(b'changed')
            return self.response, 'req'
        with self.assertRaisesRegex(ValueError, 'Media changed'):
            audio.run(self.media, self.out, sender, self.extract)
        self.assertFalse((self.out / 'evidence.json').exists())

    def test_truncated_response_rejected(self):
        self.response['choices'][0]['finish_reason'] = 'length'
        with self.assertRaises(ValueError):
            audio.parse(self.response)


if __name__ == '__main__':
    unittest.main()
