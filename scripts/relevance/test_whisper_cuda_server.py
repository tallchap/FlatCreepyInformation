import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from luna_batch_qa import words_from
import whisper_cuda as adapter
import whisper_cuda_client as client
import whisper_cuda_server as resident
from benchmark_whisper_cuda import compare_records


class PersistentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.media = self.root / 'clip.mp4'
        self.media.write_bytes(b'first exact final clip')
        self.stop = self.root / 'STOP.json'
        self.provider = {'model': 'small.en', 'device': 'cuda', 'compute_type': 'float32',
                         'requested_fp16': False, 'threads': 8}
        def infer(*args, **kwargs):
            segment = SimpleNamespace(start=0, end=2, text='Hello world.', words=[
                SimpleNamespace(word=' Hello', start=.1, end=.7),
                SimpleNamespace(word=' world.', start=.7, end=1.5)])
            return iter([segment]), SimpleNamespace(duration=2)
        self.model = SimpleNamespace(transcribe=Mock(side_effect=infer))
        self.service = resident.ASRService(self.root, self.stop, self.model, self.provider, 'a' * 40,
                                          resident.parameters(), load_seconds=1.25)
        self.server = resident.make_server(self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.config = self.root / 'private-endpoint.json'
        self.settings = {'protocol': resident.PROTOCOL, 'host': '127.0.0.1', 'port': self.server.server_port,
            'token': self.service.token, 'session_id': self.service.session_id, 'media_root': str(self.root),
            'stop_file': str(self.stop), 'parameters': self.service.params}
        adapter.write_json(self.config, self.settings)
        self.env = patch.dict(os.environ, {'SNIPPY_WHISPER_SERVER_CONFIG': str(self.config), 'SNIPPY_STOP_FILE': str(self.stop)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def args(self, media=None, output='asr'):
        return [str(media or self.media), '--model', 'small.en', '--language', 'en',
            '--output_dir', str(self.root / output), '--output_format', 'json',
            '--fp16', 'False', '--threads', '8', '--word_timestamps', 'True']

    def run_client(self, media=None, output='asr'):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(client.main(self.args(media, output)), 0)
        return json.loads((self.root / output / ((media or self.media).stem + '.json')).read_text())

    def test_two_final_media_are_independently_transcribed_by_one_model(self):
        first = self.run_client()
        second_media = self.root / 'trim.mp4'
        second_media.write_bytes(b'independent trimmed final media')
        second = self.run_client(second_media)
        self.assertEqual(self.model.transcribe.call_count, 2)
        self.assertEqual(first['provider']['input_sha256'], adapter.sha256(self.media))
        self.assertEqual(second['provider']['input_sha256'], adapter.sha256(second_media))
        self.assertNotEqual(first['provider']['input_sha256'], second['provider']['input_sha256'])
        self.assertEqual(first['provider']['persistent_server']['session_id'], second['provider']['persistent_server']['session_id'])
        self.assertEqual(second['provider']['persistent_server']['request_number'], 2)
        self.assertEqual(words_from(second), [{'text': 'Hello', 'start': .1, 'end': .7},
                                              {'text': 'world.', 'start': .7, 'end': 1.5}])
        self.assertEqual(self.model.transcribe.call_args.kwargs, {'language': 'en', 'beam_size': 5,
            'word_timestamps': True, 'vad_filter': False, 'condition_on_previous_text': False})
        self.assertTrue(compare_records(self.media, first, first)['passed'])
        self.assertFalse(compare_records(self.media, first, second)['passed'])

    def test_repeated_same_media_still_runs_independent_asr(self):
        self.run_client()
        self.run_client(output='other-asr')
        self.assertEqual(self.model.transcribe.call_count, 2)

    def test_client_stop_marker_prevents_submission(self):
        self.stop.write_text('{}')
        with patch.object(client.urllib.request, 'build_opener') as opener:
            with self.assertRaisesRegex(RuntimeError, 'admission stopped'):
                client.main(self.args())
            opener.assert_not_called()
        self.assertEqual(self.model.transcribe.call_count, 0)

    def test_server_stop_marker_refuses_queued_admission(self):
        other = self.root / 'client-stop.json'
        self.settings['stop_file'] = str(other)
        adapter.write_json(self.config, self.settings)
        self.stop.write_text('{}')
        with patch.dict(os.environ, {'SNIPPY_STOP_FILE': str(other)}):
            with self.assertRaisesRegex(RuntimeError, 'admission stopped'):
                client.main(self.args())
        self.assertEqual(self.model.transcribe.call_count, 0)

    def test_marker_during_inference_allows_accepted_request_to_finish(self):
        infer = self.model.transcribe.side_effect
        def stop_during(*args, **kwargs):
            self.stop.write_text('{}')
            return infer(*args, **kwargs)
        self.model.transcribe.side_effect = stop_during
        record = self.run_client()
        self.assertEqual(record['provider']['input_sha256'], adapter.sha256(self.media))
        with self.assertRaisesRegex(RuntimeError, 'admission stopped'):
            client.main(self.args(output='later'))
        self.assertEqual(self.model.transcribe.call_count, 1)

    def test_bad_token_is_rejected_without_inference(self):
        self.settings['token'] = 'b' * 40
        adapter.write_json(self.config, self.settings)
        with self.assertRaisesRegex(RuntimeError, 'authentication failed'):
            client.main(self.args())
        self.assertEqual(self.model.transcribe.call_count, 0)

    def test_model_parameter_mismatch_and_nonloopback_endpoint_fail_closed(self):
        for change in ({'host': 'example.com'}, {'parameters': resident.parameters(fp16=True)}):
            with self.subTest(change=change), patch.object(client.urllib.request, 'build_opener') as opener:
                adapter.write_json(self.config, {**self.settings, **change})
                with self.assertRaises(ValueError):
                    client.main(self.args())
                opener.assert_not_called()

    def test_server_hash_and_job_root_are_enforced(self):
        request = {'protocol': resident.PROTOCOL, 'parameters': resident.parameters(),
                   'media': str(self.media), 'input_sha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'hash differs'):
            self.service.transcribe(request)
        with self.assertRaisesRegex(ValueError, 'inside the configured'):
            self.service.transcribe({**request, 'media': str(self.root.parent / 'outside.mp4')})
        self.assertEqual(self.model.transcribe.call_count, 0)

    def test_failed_inference_has_no_retry_or_fallback_and_preserves_output(self):
        path = self.root / 'asr/clip.json'
        adapter.write_json(path, {'existing': True})
        self.model.transcribe.side_effect = RuntimeError('GPU inference failed')
        with patch.object(adapter, 'load_model') as loader, self.assertRaisesRegex(RuntimeError, 'GPU inference failed'):
            client.main(self.args())
        loader.assert_not_called()
        self.assertEqual(self.model.transcribe.call_count, 1)
        self.assertEqual(json.loads(path.read_text()), {'existing': True})

    def test_forged_response_hash_or_runtime_never_publishes(self):
        original = self.service.transcribe
        for field, value in [('input_sha256', '0' * 64), ('device', 'cpu'), ('beam_size', 1)]:
            def altered(request):
                record = original(request)
                record['provider'][field] = value
                return record
            with self.subTest(field=field), patch.object(self.service, 'transcribe', side_effect=altered):
                with self.assertRaises(ValueError):
                    client.main(self.args())
                self.assertFalse((self.root / 'asr/clip.json').exists())


if __name__ == '__main__':
    unittest.main()
