import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import audit
import checkpoint_shadow as checkpoint


class CheckpointTests(unittest.TestCase):
    def fixture(self, base):
        root = Path(base) / 'run'
        record = {'candidate_id': 'abcdefghijk', 'status': 'awaiting_astra',
                  'directory': '/Users/ori/run/rendered/abcdefghijk-hash'}
        audit.atomic(root / 'records/abcdefghijk.json', record)
        audit.atomic(root / 'input/candidates/abcdefghijk.json', {'candidate_id': 'abcdefghijk', 'context_transcript': '[0] Test context.'})
        audit.atomic(root / 'input/manifest.json', {'candidates': [{'candidate_id': 'abcdefghijk'}],
                                                'authorization': 'User authorized the production run'})
        audit.atomic(root / 'status.json', {'covered': 1})
        audit.atomic(root / 'checkpoint-status.json', {'luna_cost_usd': .125})
        audit.atomic(root / 'checkpoint-paths.json', {'/Users/ori/run': str(root / 'mac-checkpoint')})
        audit.atomic(root / 'rendered/abcdefghijk-hash/result.json', {
            'candidate_id': 'abcdefghijk', 'clip_path': str(root / 'rendered/abcdefghijk-hash/clip.mp4'),
            'output_sha256': hashlib.sha256(b'video').hexdigest(), 'output_bytes': 5})
        audit.atomic(root / 'rendered/abcdefghijk-hash/asr/clip.json', {'words': [{'text': 'Test'}]})
        (root / 'rendered/abcdefghijk-hash/clip.mp4').write_bytes(b'video')
        (root / 'rendered/abcdefghijk-hash/contact.jpg').write_bytes(b'jpeg')
        audit.atomic(root / 'batches/b1/call1/call-state.json', {'role': 'finalizer', 'status': 'response_saved'})
        audit.atomic(root / 'batches/b1/call1/response.json', {'id': 'response1', 'model': 'gpt-6-luna',
            'status': 'completed', 'usage': {'input_tokens': 1000, 'output_tokens': 100,
                'total_tokens': 1100, 'input_tokens_details': {'cached_tokens': 100, 'cache_write_tokens': 20}}})
        audit.atomic(root / 'batches/b1/call1/request.json', {'image': 'data:image/jpeg;base64,EXCLUDED'})
        audit.atomic(root / 'batches/b1/call1/packages.json', {'image': 'EXCLUDED'})
        audit.atomic(root / 'batches/b1/call2/call-state.json', {'role': 'verifier', 'status': 'started'})
        audit.atomic(root / 'batches/b1/pipelines/p/astra-escalations/abcdefghijk.json', {'candidate_id': 'abcdefghijk'})
        (root / 'private.env').write_text('OPENAI_API_KEY=EXCLUDED', encoding='utf-8')
        return root

    def test_snapshot_preserves_evidence_excludes_footage_and_summarizes_usage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.fixture(tmp)
            summary = checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')
            path = Path(summary['directory'])
            copied = sorted(p.relative_to(path).as_posix() for p in path.rglob('*') if p.is_file())
            self.assertFalse(any(Path(name).suffix in checkpoint.MEDIA_SUFFIXES for name in copied))
            self.assertFalse(any(name.endswith(('private.env', '/request.json', '/packages.json', '/response.json')) for name in copied))
            self.assertIn('artifacts/rendered/abcdefghijk-hash/asr/clip.json', copied)
            self.assertIn('artifacts/rendered/abcdefghijk-hash/contact.jpg', copied)
            self.assertEqual((path / 'artifacts/records/abcdefghijk.json').read_bytes(), (root / 'records/abcdefghijk.json').read_bytes())
            manifest = json.loads((path / 'manifest.json').read_text())
            for item in manifest['files']:
                data = (path / item['path']).read_bytes()
                self.assertEqual(len(data), item['size'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), item['sha256'])
            usage = json.loads((path / 'response-usage.json').read_text())
            self.assertEqual(usage['responses'][0]['categories']['uncached_input_tokens'], 880)
            self.assertEqual(len(usage['unknown_charge_calls']), 1)
            self.assertEqual(summary['unknown_charge_calls'], 1)
            self.assertAlmostEqual(summary['known_total_cost_usd'], .125 + .0001415)
            inventory = json.loads((path / 'media-inventory.json').read_text())
            self.assertTrue(inventory['items'][0]['size_matches_receipt'])
            self.assertEqual(inventory['items'][0]['sha256'], hashlib.sha256(b'video').hexdigest())
            mapping = json.loads((path / 'locator-map.json').read_text())
            self.assertEqual(mapping['prefix_mappings'][1]['source_prefix'], '/Users/ori/run')
            self.assertEqual(summary['media_bytes_copied'], 0)

    def test_repeated_snapshots_have_new_names_and_do_not_mutate_previous(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.fixture(tmp)
            first = Path(checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')['directory'])
            previous = (first / 'artifacts/status.json').read_bytes()
            audit.atomic(root / 'status.json', {'covered': 2})
            second = Path(checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')['directory'])
            self.assertNotEqual(first, second)
            self.assertEqual((first / 'artifacts/status.json').read_bytes(), previous)
            self.assertNotEqual((second / 'artifacts/status.json').read_bytes(), previous)

    def test_credentials_in_allowlisted_json_fail_without_publishing_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.fixture(tmp)
            audit.atomic(root / 'recipes/secret.json', {'private_key': 'sensitive value'})
            output = Path(tmp) / 'checkpoints'
            with self.assertRaisesRegex(ValueError, 'Credential'):
                checkpoint.create_checkpoint(root, output)
            self.assertFalse(list(output.glob('checkpoint-*')))
            self.assertFalse(any(b'sensitive value' in p.read_bytes() for p in output.rglob('*') if p.is_file()))

    def test_output_under_run_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.fixture(tmp)
            with self.assertRaisesRegex(ValueError, 'outside'):
                checkpoint.create_checkpoint(root, root / 'checkpoints')

    def test_credential_authorization_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Credential'):
            checkpoint.reject_secrets({'headers': {'Authorization': 'Bearer secret'}})


if __name__ == '__main__':
    unittest.main()
