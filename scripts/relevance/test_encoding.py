from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import shutil
import subprocess
from unittest.mock import MagicMock, patch

import audit
import encoding
import process_astra
from bounded_window_cache import read
import test_bounded_window_cache as cache_tests
import test_luna_batch_qa as luna_tests
import luna_batch_qa as luna


class EncodingTests(unittest.TestCase):
    def test_default_slow_and_opt_in_identity_bind_profile_binary_and_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / 'ffmpeg.exe'; binary.write_bytes(b'binary-v1')
            with patch('encoding.subprocess.run', return_value=SimpleNamespace(stdout='ffmpeg version fixture1\n')):
                slow = encoding.selected({'SNIPPY_FFMPEG': str(binary)})
                gpu = encoding.selected({'SNIPPY_FFMPEG': str(binary), 'SNIPPY_ENCODER_PROFILE': 'nvenc_p4'})
                self.assertEqual(slow['profile'], 'x264_slow')
                self.assertNotEqual(slow['identity'], gpu['identity'])
                binary.write_bytes(b'binary-v2')
                changed = encoding.selected({'SNIPPY_FFMPEG': str(binary), 'SNIPPY_ENCODER_PROFILE': 'nvenc_p4'})
                self.assertNotEqual(gpu['identity'], changed['identity'])
            with patch('encoding.subprocess.run', return_value=SimpleNamespace(stdout='ffmpeg version fixture2\n')):
                self.assertNotEqual(changed['identity'], encoding.selected({'SNIPPY_FFMPEG': str(binary), 'SNIPPY_ENCODER_PROFILE': 'nvenc_p4'})['identity'])

    def test_no_silent_unknown_profile_or_binary_fallback(self):
        with self.assertRaisesRegex(ValueError, 'no encoder fallback'):
            encoding.selected({'SNIPPY_ENCODER_PROFILE': 'guess'})
        with self.assertRaisesRegex(ValueError, 'missing; no fallback'):
            encoding.selected({'SNIPPY_FFMPEG': 'missing-test-binary-123.exe'})
        self.assertTrue(encoding.native_fps({'r_frame_rate': '30000/1001'}, {'r_frame_rate': '60000/2002'}))
        self.assertFalse(encoding.native_fps({'r_frame_rate': '30/1'}, {'r_frame_rate': '30000/1001'}))

    def test_initial_cached_hit_validates_current_generation_cull_and_hash_without_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); directory, inputs = cache_tests.BoundedWindowCacheTests().fixture(root)
            codec = {'identity': 'test-encoding-identity'}
            recipe, packet = read(directory / 'recipe.json'), read(inputs / 'candidates/abcdefghijk.json')
            identity = audit.digest({'recipe': recipe, 'generation': '123', 'encoding': codec['identity']})
            target = directory.parent / ('abcdefghijk-' + identity[:20]); directory.rename(target)
            result, qa = read(target / 'result.json'), read(target / 'qa.json')
            result.update(encoding_identity=codec['identity'], recipe_hash=identity)
            result['automated_qa']['native_fps'] = True; qa['checks']['native_fps'] = True
            audit.atomic(target / 'result.json', result); audit.atomic(target / 'qa.json', qa)
            current = packet['gcs_object'].copy()
            response = MagicMock(); response.json.side_effect = lambda: current.copy()
            session = MagicMock(); session.get.return_value = response
            with patch('encoding.selected', return_value=codec), patch('google.auth.default', return_value=(None, None)), patch('google.auth.transport.requests.AuthorizedSession') as factory, patch('process_astra.RangeProxy', side_effect=AssertionError('no source body on hit')):
                factory.return_value.__enter__.return_value = session
                self.assertEqual(process_astra.render(SimpleNamespace(output=root/'rendered'), recipe, packet, {'renderable': True}), result)
                self.assertEqual(session.get.call_count, 1)
                current['generation'] = 'changed'
                with self.assertRaisesRegex(ValueError, 'Source generation/size changed'):
                    process_astra.render(SimpleNamespace(output=root/'rendered'), recipe, packet, {'renderable': True})
                current.update(packet['gcs_object'])
                current['size'] = '1000'
                with self.assertRaisesRegex(ValueError, 'Source generation/size changed'):
                    process_astra.render(SimpleNamespace(output=root/'rendered'), recipe, packet, {'renderable': True})
                current.update(packet['gcs_object'])
                audit.atomic(inputs / 'culled-ids.json', [{'video_id': 'abcdefghijk'}])
                with self.assertRaisesRegex(ValueError, 'Culled'):
                    process_astra.render(SimpleNamespace(output=root/'rendered'), recipe, packet, {'renderable': True})

    def test_default_profile_preserves_legacy_initial_cache_after_live_metadata_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); directory, inputs = cache_tests.BoundedWindowCacheTests().fixture(root)
            recipe, packet, result = read(directory/'recipe.json'), read(inputs/'candidates/abcdefghijk.json'), read(directory/'result.json')
            target = directory.parent / ('abcdefghijk-' + result['recipe_hash'][:20]); directory.rename(target)
            with patch.dict('os.environ', {}, clear=True), patch('encoding.selected', return_value={'identity': 'new-identity'}), patch('process_astra.verify_current_source', return_value=packet['gcs_object']) as current, patch('process_astra.RangeProxy', side_effect=AssertionError('legacy cache must not re-render')):
                self.assertEqual(process_astra.render(SimpleNamespace(output=root/'rendered'), recipe, packet, {'renderable': True}), result)
                current.assert_called_once_with(packet['gcs_object'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_original_trim_uses_source_relative_ranges_and_actual_transfer_then_validated_cache(self):
        fixture = luna_tests.BatchTests(); fixture.setUp()
        self.addCleanup(fixture.tearDown)
        root, parent, vid = fixture.root, fixture.clip, fixture.vid
        inputs = root / 'input'; packets = inputs / 'candidates'; packets.mkdir(parents=True)
        obj = {'bucket': 'fixture', 'name': vid + '.mp4', 'generation': '1', 'size': '999999'}
        packet = {**read(fixture.packets / (vid + '.json')), 'gcs_object': obj, 'source_duration_seconds': 150}
        audit.atomic(packets / (vid + '.json'), packet)
        audit.atomic(inputs / 'manifest.json', {'candidates': [{'candidate_id': vid, 'packet_sha256': audit.digest(packet)}]})
        audit.atomic(inputs / 'culled-ids.json', [])
        checks = dict.fromkeys(('video', 'audio', 'duration', 'native_dimensions', 'full_decode'), True)
        parent_result = read(parent / 'result.json')
        parent_result.update(recipe_hash=audit.digest({'recipe': fixture.recipe, 'generation': '1', 'encoding': 'h264-crf18-slow-aac192-v1'}), automated_qa=checks)
        audit.atomic(parent / 'result.json', parent_result); audit.atomic(parent / 'source.json', obj)
        parent_qa = read(parent / 'qa.json'); parent_qa['checks'] = checks
        parent_qa['ffprobe']['streams'][0]['r_frame_rate'] = '10/1'; audit.atomic(parent / 'qa.json', parent_qa)
        evidence = luna.package(parent, packets)['evidence']
        plan = luna.trim_plan(evidence, 5, 25, final_title='Retained', final_description='Retained words.')
        plan.update(parent_clip_dir=str(parent), reason='Trim fixture edges')
        path = root / 'trim.json'; audit.atomic(path, plan)
        # A real decoded source-render fixture; the encoded parent is deliberately
        # invalid media, so this proves the parent is never used as FFmpeg input.
        source_output = root / 'original-clip.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '20', '-c:v', 'libx264', '-c:a', 'aac', str(source_output)], capture_output=True, check=True)
        codec = {'identity': 'test-original-profile'}
        transfer = {'upstream_body_bytes_read': 65432, 'original_cache_body_bytes_read': 12345, 'max_bytes': 268435456}
        returned = {'clip_path': str(source_output), 'encoding_identity': codec['identity'], 'transfer': transfer}
        with patch.dict('os.environ', {'SNIPPY_ORIGINAL_RANGE_CACHE': str(root/'rawcache')}, clear=False), patch('encoding.selected', return_value=codec), patch('process_astra.render', return_value=returned) as renderer, patch('process_astra.verify_current_source', return_value=obj) as current:
            result = luna.execute_trim(path, root / 'trimmed')
            args, revised, called_packet, validation = renderer.call_args.args
            self.assertEqual(revised['edits'], [{'start_seconds': 105, 'end_seconds': 125, 'transcript': 'word1 word2 word3 word4'}])
            self.assertEqual(called_packet, packet)
            self.assertEqual(validation, {'renderable': True, 'duration_seconds': 20})
            self.assertEqual(result['additional_gcs_bytes_read'], 65432)
            self.assertEqual(result['transfer'], transfer)
            self.assertTrue(all(result['automated_qa'].values()))
            self.assertTrue(result['original_source'])
            self.assertEqual(luna.execute_trim(path, root / 'trimmed'), result)
            self.assertEqual(renderer.call_count, 1)
            current.assert_called_once_with(obj)
            current.side_effect = ValueError('Source generation/size changed since review packet')
            with self.assertRaisesRegex(ValueError, 'generation/size changed'):
                luna.execute_trim(path, root / 'trimmed')
            audit.atomic(inputs / 'culled-ids.json', [{'video_id': vid}])
            with self.assertRaisesRegex(ValueError, 'Culled'):
                luna.execute_trim(path, root / 'trimmed')
            self.assertEqual(renderer.call_count, 1)


if __name__ == '__main__':
    unittest.main()
