import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from luna_batch_qa import words_from
import whisper_cuda as adapter


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.media = self.root / 'clip.mp4'
        self.media.write_bytes(b'fixed media input')
        self.provider = {'model': 'small.en', 'device': 'cuda', 'compute_type': 'float32'}

    def model(self, words):
        segment = SimpleNamespace(start=0, end=2, text=' Hello world.', words=[
            SimpleNamespace(word=text, start=start, end=end) for text, start, end in words])
        return SimpleNamespace(transcribe=Mock(return_value=(iter([segment]), SimpleNamespace(duration=2))))

    def test_word_contract_and_media_binding(self):
        model = self.model([(' Hello', 0.1, 0.8), (' world.', 0.8, 1.3)])
        record = adapter.transcribe_media(self.media, model, self.provider)
        self.assertEqual(words_from(record), [
            {'text': 'Hello', 'start': 0.1, 'end': 0.8},
            {'text': 'world.', 'start': 0.8, 'end': 1.3}])
        self.assertEqual(record['provider']['input_sha256'], adapter.sha256(self.media))
        self.assertEqual(record['provider']['model'], 'small.en')
        self.assertEqual(record['provider']['device'], 'cuda')
        self.assertTrue(model.transcribe.call_args.kwargs['word_timestamps'])
        self.assertFalse(model.transcribe.call_args.kwargs['vad_filter'])

    def test_fail_closed_for_invalid_or_empty_word_timing(self):
        for words in ([], [('bad', float('nan'), 1)], [('bad', -1, 1)],
                      [('bad', 1, 0)], [('a', 1, 2), ('b', 0, 1)]):
            with self.subTest(words=words), self.assertRaises(ValueError):
                adapter.transcribe_media(self.media, self.model(words), self.provider)

    def test_media_mutation_is_rejected(self):
        model = self.model([('Hi', 0, 1)])
        original = model.transcribe.return_value
        def transcribe(*args, **kwargs):
            self.media.write_bytes(b'changed')
            return original
        model.transcribe.side_effect = transcribe
        with self.assertRaisesRegex(ValueError, 'changed during'):
            adapter.transcribe_media(self.media, model, self.provider)

    def test_ensure_asr_cli_contract_and_output(self):
        argv = [str(self.media), '--model', 'small.en', '--language', 'en',
                '--output_dir', str(self.root / 'asr'), '--output_format', 'json',
                '--fp16', 'False', '--threads', '8', '--word_timestamps', 'True']
        with patch.object(adapter, 'load_model', return_value=(self.model([('Hi', 0, 1)]), self.provider)) as loader:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(adapter.main(argv), 0)
        loader.assert_called_once_with(False, 8, None)
        record = json.loads((self.root / 'asr/clip.json').read_text(encoding='utf-8'))
        self.assertEqual(words_from(record)[0]['text'], 'Hi')

    def test_lazy_transcription_failure_does_not_publish(self):
        def failed():
            raise RuntimeError('GPU inference failed')
            yield
        model = SimpleNamespace(transcribe=Mock(return_value=(failed(), SimpleNamespace(duration=2))))
        with patch.object(adapter, 'load_model', return_value=(model, self.provider)):
            with self.assertRaisesRegex(RuntimeError, 'GPU inference failed'):
                adapter.main([str(self.media), '--output_dir', str(self.root / 'asr')])
        self.assertFalse((self.root / 'asr/clip.json').exists())

    def test_model_cpu_and_missing_timestamps_are_rejected(self):
        for flag, value in [('--model', 'large-v3-turbo'), ('--device', 'cpu'),
                            ('--word_timestamps', 'False'), ('--language', 'fr')]:
            with self.subTest(flag=flag), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    adapter.parser().parse_args([str(self.media), '--output_dir', str(self.root), flag, value])

    def runtime_modules(self, count=1, actual_device='cuda', actual_compute='float32'):
        runtime = SimpleNamespace(device=actual_device, compute_type=actual_compute)
        fw = SimpleNamespace(__version__='test', WhisperModel=Mock(return_value=SimpleNamespace(model=runtime)))
        utils = SimpleNamespace(download_model=Mock(return_value='small.en-cache'))
        ct = SimpleNamespace(__version__='test', get_cuda_device_count=Mock(return_value=count),
                             get_supported_compute_types=Mock(return_value={'float32', 'float16'}))
        return {'faster_whisper': fw, 'faster_whisper.utils': utils, 'ctranslate2': ct}

    def test_model_load_requires_cuda_and_validates_actual_runtime(self):
        for count, device, compute in [(0, 'cuda', 'float32'), (1, 'cpu', 'float32'), (1, 'cuda', 'int8')]:
            modules = self.runtime_modules(count, device, compute)
            with self.subTest(count=count, device=device, compute=compute), patch.dict('sys.modules', modules):
                with patch.object(adapter, 'prepare_dll_dirs'), self.assertRaises(RuntimeError):
                    adapter.load_model()

    def test_cached_small_en_and_explicit_cuda_selected(self):
        modules = self.runtime_modules()
        with patch.dict('sys.modules', modules), patch.object(adapter, 'prepare_dll_dirs'):
            _, provider = adapter.load_model()
        modules['faster_whisper.utils'].download_model.assert_called_once_with('small.en', local_files_only=True, cache_dir=None)
        modules['faster_whisper'].WhisperModel.assert_called_once_with(
            'small.en-cache', device='cuda', device_index=0, compute_type='float32', cpu_threads=8, local_files_only=True)
        self.assertEqual(provider['device'], 'cuda')
        self.assertTrue(provider['local_files_only'])

    def test_failed_json_write_preserves_existing_file_and_cleans_temp(self):
        path = self.root / 'existing.json'
        path.write_text('{"original":true}', encoding='utf-8')
        with self.assertRaises(ValueError):
            adapter.write_json(path, {'invalid': float('nan')})
        self.assertEqual(json.loads(path.read_text()), {'original': True})
        self.assertEqual(list(self.root.glob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
