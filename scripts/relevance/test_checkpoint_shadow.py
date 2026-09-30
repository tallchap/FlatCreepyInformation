import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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

    def archive_fixture(self, root, extra=None):
        archive = root / 'experiments/wave-one'
        payloads = {
            'checkpoint-upload-receipt.json': b'{"receipt": "verified"}\r\n',
            'next-experiment-plan.json': b'{"experiment_id": "wave-two"}\n',
            'artifacts/production-attempt-1.log': b'Preparation complete.\r\n',
        }
        for path in root.rglob('*'):
            if path.is_file() and path.suffix in {'.json', '.jpg'} and path.name not in {'request.json', 'packages.json'}:
                payloads['artifacts/' + path.relative_to(root).as_posix()] = path.read_bytes()
        payloads.update(extra or {})
        entries = []
        for relative, data in payloads.items():
            path = archive / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            entries.append({'path': relative, 'source_relative': relative.removeprefix('artifacts/') if relative.startswith('artifacts/') else None,
                            'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        audit.atomic(archive / 'archive-manifest.json', {'schema_version': 'snippy-wave-archive-v1',
            'experiment_id': 'wave-one', 'files': entries,
            'first_wave_unknown_charge_evidence_preserved': [{'request_path': 'batches/b1/call2/request.json', 'charge_unknown': True}]})
        self.bind_transition(root, archive)
        return archive

    def bind_transition(self, root, archive):
        audit.atomic(root / 'experiment-transition.json', {'archive_relative': archive.relative_to(root).as_posix(),
            'archive_manifest_sha256': hashlib.sha256((archive / 'archive-manifest.json').read_bytes()).hexdigest()})

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

    def test_paused_optimization_evidence_preserved_and_unsent_call_not_charged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.fixture(tmp)
            audit.atomic(root / 'batches/b1/call2/call-state.json', {
                'status': 'cancelled_before_dispatch', 'dispatched': False, 'charge_unknown': False})
            audit.atomic(root / 'paused-wave-records/abcdefghijk.json', {'status': 'reviewing'})
            audit.atomic(root / 'optimization-evidence/encoder/report.json', {'seconds': 2.1})
            (root / 'optimization-evidence/encoder/clip.mp4').write_bytes(b'excluded footage')
            summary = checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')
            result = Path(summary['directory']) / 'artifacts'
            self.assertEqual(summary['unknown_charge_calls'], 0)
            self.assertTrue((result / 'paused-wave-records/abcdefghijk.json').exists())
            self.assertTrue((result / 'optimization-evidence/encoder/report.json').exists())
            self.assertFalse((result / 'optimization-evidence/encoder/clip.mp4').exists())
            self.assertTrue((result / 'batches/b1/call2/call-state.json').exists())

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

    def test_immutable_archive_bytes_hashes_and_live_accounting_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.fixture(tmp)
            audit.atomic(root / 'rendered/abcdefghijk-hash/transfer.json', {'upstream_body_bytes_read': 11, 'upstream_requested_bytes': 20})
            audit.atomic(root / 'publications/snippet.json', {'snippet_id': 's1', 'video_id': 'abcdefghijk',
                'query_bytes_billed': 100, 'uploaded_bytes': 5})
            before = checkpoint.create_checkpoint(root, Path(tmp) / 'before')
            archive = self.archive_fixture(root)
            # Unreferenced archive media cannot enter current statistics or copy.
            (archive / 'artifacts/rendered/abcdefghijk-hash/clip.mp4').write_bytes(b'old-copy')
            audit.atomic(root / 'mac-checkpoint/experiments/old/artifacts/batches/old/call/call-state.json', {'status': 'unknown_charge'})
            result = checkpoint.create_checkpoint(root, Path(tmp) / 'after')
            target = Path(result['directory'])
            manifest = json.loads((archive / 'archive-manifest.json').read_text())
            for entry in manifest['files'] + [{'path': 'archive-manifest.json'}]:
                original = archive / entry['path']
                copied = target / 'artifacts/experiments/wave-one' / entry['path']
                self.assertEqual(copied.read_bytes(), original.read_bytes())
                if 'sha256' in entry:
                    self.assertEqual(hashlib.sha256(copied.read_bytes()).hexdigest(), entry['sha256'])
            self.assertEqual((target / 'artifacts/experiment-transition.json').read_bytes(), (root / 'experiment-transition.json').read_bytes())
            self.assertEqual(result['immutable_archives'][0]['experiment_id'], 'wave-one')
            for key in ('counts', 'recorded_candidates', 'unknown_charge_calls', 'current_response_count', 'current_cost_usd',
                        'known_total_cost_usd', 'bigquery_bytes_billed', 'transfer_body_bytes_read', 'transfer_requested_bytes'):
                self.assertEqual(result[key], before[key], key)
            for name in ('response-usage.json', 'media-inventory.json', 'transfer-summary.json'):
                self.assertEqual(json.loads((target / name).read_text()), json.loads((Path(before['directory']) / name).read_text()), name)
            self.assertFalse((target / 'artifacts/experiments/wave-one/artifacts/rendered/abcdefghijk-hash/clip.mp4').exists())
            self.assertEqual(result['unknown_charge_calls'], 1)
            self.assertEqual(result['transfer_body_bytes_read'], 11)

    def test_archive_hash_change_or_missing_file_is_rejected(self):
        for missing in (False, True):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as tmp:
                root = self.fixture(tmp)
                archive = self.archive_fixture(root)
                response = archive / 'artifacts/batches/b1/call1/response.json'
                response.unlink() if missing else response.write_bytes(b'{"changed":true}')
                with self.assertRaises((ValueError, FileNotFoundError)):
                    checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')
                self.assertFalse(list((Path(tmp) / 'checkpoints').glob('checkpoint-*')))

    def test_transition_cannot_silently_omit_a_missing_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.fixture(tmp)
            audit.atomic(root / 'experiment-transition.json', {'archive_relative': 'experiments/missing',
                'archive_manifest_sha256': '0' * 64})
            with self.assertRaisesRegex(ValueError, 'missing immutable archive'):
                checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')

    def test_archive_manifest_requires_transition_binding_unique_paths_and_receipts(self):
        for mutation in ('changed_manifest', 'duplicate', 'missing_receipt'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                root = self.fixture(tmp)
                archive = self.archive_fixture(root)
                path = archive / 'archive-manifest.json'
                manifest = json.loads(path.read_text())
                if mutation == 'duplicate':
                    manifest['files'].append(manifest['files'][0])
                elif mutation == 'missing_receipt':
                    manifest['files'] = [e for e in manifest['files'] if e['path'] != 'checkpoint-upload-receipt.json']
                else:
                    manifest['changed'] = True
                audit.atomic(path, manifest)
                if mutation != 'changed_manifest':
                    self.bind_transition(root, archive)
                with self.assertRaises(ValueError):
                    checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')

    def test_archive_paths_and_media_requests_are_rejected(self):
        for unsafe in ('../escape.json', '/absolute.json', 'C:/escape.json', 'artifacts/../escape.json',
                       'artifacts\\escape.json', 'artifacts/file.json:stream', 'artifacts/media.mp4',
                       'artifacts/batches/request.json', 'artifacts/batches/packages.json'):
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory() as tmp:
                root = self.fixture(tmp)
                archive = self.archive_fixture(root)
                path = archive / 'archive-manifest.json'
                manifest = json.loads(path.read_text())
                manifest['files'].append({'path': unsafe, 'size': 0, 'sha256': hashlib.sha256(b'').hexdigest()})
                audit.atomic(path, manifest)
                self.bind_transition(root, archive)
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')

    def test_archive_json_jsonl_and_logs_reject_credentials_before_copy(self):
        for name, data in (('secret.json', b'{"private_key":"sensitive value"}'),
                           ('events.jsonl', b'{"headers":{"Authorization":"Bearer sensitive value"}}\n'),
                           ('runner.log', b'OPENAI_API_KEY=sensitive-value\n')):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = self.fixture(tmp)
                self.archive_fixture(root, {'artifacts/' + name: data})
                output = Path(tmp) / 'checkpoints'
                with self.assertRaisesRegex(ValueError, 'Credential'):
                    checkpoint.create_checkpoint(root, output)
                self.assertFalse(any(b'sensitive' in p.read_bytes() for p in output.rglob('*') if p.is_file()))

    def test_archive_symlink_ancestor_is_rejected_even_inside_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.fixture(tmp)
            self.archive_fixture(root)
            original = Path.is_symlink
            with patch.object(Path, 'is_symlink', lambda p: p.name == 'wave-one' or original(p)):
                with self.assertRaisesRegex(ValueError, 'Symlink'):
                    checkpoint.create_checkpoint(root, Path(tmp) / 'checkpoints')

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
