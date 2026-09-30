import json
from pathlib import Path
import tempfile
import unittest

import audit
from bounded_window_cache import open_window
from process_astra import sha


class BoundedWindowCacheTests(unittest.TestCase):
    def fixture(self, root):
        directory, inputs = root / 'rendered/window', root / 'input'
        directory.mkdir(parents=True)
        vid = 'abcdefghijk'
        obj = {'bucket': 'snippysaurus-clips', 'name': 'videos/' + vid + '.mp4', 'generation': '123', 'size': '999'}
        recipe = {'candidate_id': vid, 'source_input_hash': 'source-hash',
                  'edits': [{'start_seconds': 10, 'end_seconds': 30, 'transcript': 'fixture speech'}]}
        packet = {'candidate_id': vid, 'source_input_hash': 'source-hash', 'source_duration_seconds': 100, 'gcs_object': obj}
        checks = dict.fromkeys(('video', 'audio', 'duration', 'native_dimensions', 'full_decode'), True)
        (directory / 'clip.mp4').write_bytes(b'fixture-media-not-an-encode-test')
        result = {'candidate_id': vid, 'source_input_hash': 'source-hash', 'source_generation': '123',
                  'recipe_hash': audit.digest({'recipe': recipe, 'generation': '123', 'encoding': 'h264-crf18-slow-aac192-v1'}),
                  'output_sha256': sha(directory / 'clip.mp4'), 'duration_seconds': 20, 'automated_qa': checks}
        for name, value in [('recipe.json', recipe), ('result.json', result), ('qa.json', {'checks': checks}), ('source.json', obj)]:
            audit.atomic(directory / name, value)
        audit.atomic(inputs / 'candidates' / (vid + '.json'), packet)
        audit.atomic(inputs / 'manifest.json', {'candidates': [{'candidate_id': vid, 'packet_sha256': audit.digest(packet)}]})
        audit.atomic(inputs / 'culled-ids.json', [])
        return directory, inputs

    def test_reuse_is_offline_stable_and_zero_additional_source_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, inputs = self.fixture(Path(tmp))
            first = open_window(directory, inputs)
            # Encoder experiments live outside the cached source and do not change its identity.
            (Path(tmp) / 'nvenc-experiment.mp4').write_bytes(b'unrelated variant')
            second = open_window(directory, inputs)
            self.assertEqual(first['cache_key'], second['cache_key'])
            self.assertEqual(first['media_sha256'], second['media_sha256'])
            self.assertTrue(second['cache_hit'])
            self.assertEqual(second['additional_gcs_bytes_read'], 0)

    def test_latest_cull_is_checked_on_every_hit(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, inputs = self.fixture(Path(tmp))
            open_window(directory, inputs)
            audit.atomic(inputs / 'culled-ids.json', [{'video_id': 'abcdefghijk'}])
            with self.assertRaisesRegex(ValueError, 'Culled'):
                open_window(directory, inputs)

    def test_revised_window_binds_original_parent_and_its_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); parent, inputs = self.fixture(root)
            recipe = json.loads((parent / 'recipe.json').read_text()); source_result = json.loads((parent / 'result.json').read_text())
            child = root / 'trimmed/child'; child.mkdir(parents=True)
            trim = {'parent_clip_dir': str(parent), 'media_sha256': source_result['output_sha256'],
                    'recipe_hash': audit.digest(recipe), 'source_generation': '123'}
            revised = {**recipe, 'parent_media_sha256': source_result['output_sha256'],
                       'edits': [{'start_seconds': 11, 'end_seconds': 29, 'transcript': 'fixture speech'}]}
            (child / 'clip.mp4').write_bytes(b'fixture-revised-media')
            result = {**source_result, 'recipe_hash': audit.digest(revised), 'duration_seconds': 18,
                      'output_sha256': sha(child / 'clip.mp4')}
            for name, value in [('recipe.json', revised), ('result.json', result), ('trim.json', trim), ('qa.json', json.loads((parent/'qa.json').read_text()))]:
                audit.atomic(child/name, value)
            hit = open_window(child, inputs)
            self.assertEqual(hit['source_object']['generation'], '123')
            self.assertEqual(hit['source_ranges'][0]['start_seconds'], 11)
            (parent/'clip.mp4').write_bytes(b'changed-original')
            with self.assertRaisesRegex(ValueError, 'media hash'):
                open_window(child, inputs)

    def test_source_generation_packet_recipe_media_and_qa_drift_fail_closed(self):
        mutations = [
            ('source.json', lambda j: j.update(generation='456'), 'source object identity'),
            ('result.json', lambda j: j.update(source_generation='456'), 'generation drift'),
            ('recipe.json', lambda j: j['edits'][0].update(end_seconds=31), 'recipe/encoding identity'),
            ('qa.json', lambda j: j['checks'].update(full_decode=False), 'technical QA'),
            ('result.json', lambda j: j.update(output_sha256='changed'), 'media hash'),
        ]
        for name, mutate, expected in mutations:
            with self.subTest(name=name, expected=expected), tempfile.TemporaryDirectory() as tmp:
                directory, inputs = self.fixture(Path(tmp))
                path = directory / name
                value = json.loads(path.read_text()); mutate(value); audit.atomic(path, value)
                with self.assertRaisesRegex(ValueError, expected):
                    open_window(directory, inputs)
        with tempfile.TemporaryDirectory() as tmp:
            directory, inputs = self.fixture(Path(tmp))
            path = inputs / 'candidates/abcdefghijk.json'
            value = json.loads(path.read_text()); value['source_duration_seconds'] = 101; audit.atomic(path, value)
            with self.assertRaisesRegex(ValueError, 'packet hash'):
                open_window(directory, inputs)


if __name__ == '__main__':
    unittest.main()
