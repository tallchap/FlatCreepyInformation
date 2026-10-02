import base64
import io
import json
import shutil
import subprocess
import urllib.error
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

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
            return json.dumps(self.response).encode(), 'request-1'
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
            audio.run(self.media, self.out, lambda _: (json.dumps(self.response).encode(), 'req'), self.extract)
        self.assertTrue((self.out / 'response.json').exists())
        self.assertFalse((self.out / 'evidence.json').exists())

    def test_changed_media_cannot_produce_ready_evidence(self):
        def sender(_):
            self.media.write_bytes(b'changed')
            return json.dumps(self.response).encode(), 'req'
        with self.assertRaisesRegex(ValueError, 'Media changed'):
            audio.run(self.media, self.out, sender, self.extract)
        self.assertFalse((self.out / 'evidence.json').exists())

    def test_truncated_response_rejected(self):
        self.response['choices'][0]['finish_reason'] = 'length'
        with self.assertRaises(ValueError):
            audio.parse(self.response)


    def test_bad_transport_json_preserves_raw_bytes_and_request_id(self):
        raw = b'{"choices": broken \xff'
        with self.assertRaises(ValueError):
            audio.run(self.media, self.out, lambda _: (raw, 'req-transport'), self.extract)
        saved = json.loads((self.out / 'response.json').read_text())
        self.assertEqual(base64.b64decode(saved['response_body_base64']), raw)
        self.assertEqual(saved['request_id'], 'req-transport')
        self.assertEqual(saved['http_status'], 200)
        self.assertEqual(json.loads((self.out / 'failure.json').read_text())['status'], 'evidence_failed')
        self.assertFalse((self.out / 'evidence.json').exists())

    def test_http_error_preserves_provider_receipt_without_retry(self):
        sender = Mock(side_effect=urllib.error.HTTPError('https://api.openai.com', 403,
            'denied', {'x-request-id': 'req-denied'}, io.BytesIO(b'denied')))
        with self.assertRaises(urllib.error.HTTPError):
            audio.run(self.media, self.out, sender, self.extract)
        saved = json.loads((self.out / 'failure.json').read_text())
        self.assertEqual((saved['http_status'], saved['request_id'], saved['error_body']),
                         (403, 'req-denied', 'denied'))
        self.assertFalse(saved['charge_reconciled'])
        sender.assert_called_once()

    def test_preparation_failure_is_recorded_and_never_sends(self):
        sender = Mock()
        with self.assertRaises(ValueError):
            audio.run(self.media, self.out, sender, Mock(side_effect=ValueError('no audio')))
        saved = json.loads((self.out / 'failure.json').read_text())
        self.assertEqual(saved['status'], 'preparation_failed')
        self.assertFalse(saved['request_sent'])
        sender.assert_not_called()

    def test_changed_media_during_extraction_never_sends(self):
        def extract(media, target):
            self.extract(media, target)
            media.write_bytes(b'changed')
        sender = Mock()
        with self.assertRaisesRegex(ValueError, 'Media changed'):
            audio.run(self.media, self.out, sender, extract)
        sender.assert_not_called()

    def test_refusal_and_missing_or_wrong_type_fields_fail_closed(self):
        for content in ({}, [], dict.fromkeys(audio.FIELDS, None)):
            self.response['choices'][0]['message']['content'] = json.dumps(content)
            with self.assertRaises(ValueError):
                audio.parse(self.response)
        self.response['choices'][0]['message']['refusal'] = 'no'
        with self.assertRaises(ValueError):
            audio.parse(self.response)

    def test_fenced_json_is_supported(self):
        message = self.response['choices'][0]['message']
        message['content'] = '```json\n' + message['content'] + '\n```'
        self.assertEqual(set(audio.parse(self.response)), set(audio.FIELDS))

    def test_send_preserves_raw_transport_response(self):
        response = Mock()
        response.read.return_value = b'incomplete json'
        response.headers = {'x-request-id': 'req-raw'}
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(audio.audit, 'api_key', return_value='test-key'), \
                patch.object(audio.urllib.request, 'urlopen', return_value=response) as call:
            self.assertEqual(audio.send(b'{}'), (b'incomplete json', 'req-raw'))
        self.assertEqual(call.call_args.kwargs['timeout'], 180)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_real_multistream_input_rejected_and_single_stream_extracted(self):
        multi = self.root / 'two.mkv'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
            'sine=frequency=440:duration=0.1', '-f', 'lavfi', '-i',
            'sine=frequency=880:duration=0.1', '-map', '0:a', '-map', '1:a',
            '-c:a', 'pcm_s16le', str(multi)], check=True, capture_output=True)
        with self.assertRaisesRegex(ValueError, 'Exactly one audio stream'):
            audio.extract(multi, self.root / 'rejected.wav')
        self.assertFalse((self.root / 'rejected.wav').exists())
        single = self.root / 'single.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(multi), '-map', '0:a:0',
            str(single)], check=True, capture_output=True)
        audio.extract(single, self.root / 'accepted.wav')
        self.assertGreater((self.root / 'accepted.wav').stat().st_size, 44)


if __name__ == '__main__':
    unittest.main()
