"""No-network regressions for imported publication verification."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import audit
import verify_checkpoint as verifier


def receipt(vid='testvideo01'):
    rh = 'a' * 64
    sid = f'astra_{vid}_{rh[:12]}'
    url = f'https://storage.googleapis.com/snippysaurus-clips/clips/astra/{vid}/{rh[:16]}.mp4'
    row = {'snippet_id': sid, 'original_video_id': vid, 'title': 'Test', 'description': 'Test description',
           'category': 'ai_safety', 'duration_ms': '20000', 'transcript': 'Test speech', 'gcs_url': url,
           'provider': 'astra', 'speaker': 'Unidentified speaker', 'created_at': '2026-09-30 12:00:00+00:00'}
    return {'passed': True, 'snippet_id': sid, 'video_id': vid, 'gcs_url': url, 'gcs_generation': '12345',
            'media_sha256': 'b' * 64, 'recipe_hash': rh, 'uploaded_bytes': 1234, 'row': row}


class FakeReader:
    def __init__(self, item):
        self.item = item
        self.rows = [copy.deepcopy(item['row'])]
        self.meta = {'bucket': verifier.BUCKET, 'name': verifier.validate_receipt(item['video_id'], item),
                     'size': str(item['uploaded_bytes']), 'generation': item['gcs_generation']}
        self.site_rows = [{'snippetId': item['snippet_id'], 'gcsUrl': item['gcs_url']}]

    def database(self, receipts):
        return self.rows, {'job_id': 'fake', 'bytes_billed': 42}

    def metadata(self, name):
        return self.meta

    def playback(self, item, prefix):
        return {'bytes_read': 32, 'generation': item['gcs_generation']}

    def site(self, vid):
        return self.site_rows


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.checkpoint = self.root / 'mac-checkpoint'
        self.item = receipt()
        self.record = {'candidate_id': self.item['video_id'], 'status': 'already_published'}
        self.manifest = self.root / 'manifest.json'
        audit.atomic(self.manifest, {'candidates': [{'candidate_id': self.item['video_id']}, {'candidate_id': 'heldvideo01'}]})
        audit.atomic(self.checkpoint / 'publications' / f"{self.item['video_id']}.json", self.item)
        audit.atomic(self.checkpoint / 'records' / f"{self.item['video_id']}.json", self.record)
        audit.atomic(self.checkpoint / 'records' / 'heldvideo01.json', {'candidate_id': 'heldvideo01', 'status': 'awaiting_astra'})
        self.reader = FakeReader(self.item)

    def run_verifier(self):
        return verifier.verify(self.checkpoint, self.manifest, self.root / 'report.json', self.reader,
                               expected_records=2, expected_publications=1)

    def test_verified_import_preserves_astra_hold_and_receipt_bytes(self):
        path = self.checkpoint / 'publications' / f"{self.item['video_id']}.json"
        before = path.read_bytes()
        result = self.run_verifier()
        self.assertTrue(result['passed'])
        self.assertEqual(result['preserve_skip_ids'], ['heldvideo01', 'testvideo01'])
        self.assertEqual(result['awaiting_astra_ids'], ['heldvideo01'])
        self.assertFalse(result['replay_authorized'])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(result['query_receipt']['bytes_billed'], 42)

    def test_duplicate_source_with_different_recipe_is_held(self):
        second = dict(self.item['row'], snippet_id='astra_different_recipe')
        self.reader.rows.append(second)
        result = self.run_verifier()
        self.assertFalse(result['passed'])
        self.assertIn(self.item['video_id'], result['held_ids'])
        self.assertFalse(result['replay_authorized'])

    def test_modified_database_metadata_is_held(self):
        self.reader.rows[0]['speaker'] = 'Different speaker'
        self.assertFalse(self.run_verifier()['passed'])

    def test_generation_drift_is_held(self):
        self.reader.meta['generation'] = '99999'
        result = self.run_verifier()
        self.assertFalse(result['passed'])
        self.assertIn('testvideo01', result['preserve_skip_ids'])

    def test_site_missing_publication_is_held(self):
        self.reader.site_rows = []
        self.assertFalse(self.run_verifier()['passed'])

    def test_network_error_writes_durable_hold(self):
        def fail(_):
            raise TimeoutError('metadata timeout')
        self.reader.metadata = fail
        result = self.run_verifier()
        self.assertFalse(result['passed'])
        saved = json.loads((self.root / 'report.json').read_text())
        self.assertEqual(saved['held_ids'], ['testvideo01'])

    def test_receipt_url_cannot_send_requests_elsewhere(self):
        bad = dict(self.item, gcs_url='https://example.invalid/secret')
        with self.assertRaisesRegex(ValueError, 'Unexpected publication URL'):
            verifier.validate_receipt('testvideo01', bad)

    def test_path_remapping_rejects_escape(self):
        path = verifier.local_path(self.checkpoint, '/Users/original/production-1644/batches/final')
        self.assertEqual(path, self.checkpoint / 'batches' / 'final')
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            verifier.local_path(self.checkpoint, '/Users/original/production-1644/../../unrelated')

    def test_missing_media_accepts_verified_recipe_qa_evidence(self):
        recipe = {'candidate_id': self.item['video_id'], 'title': 'Test'}
        rh = audit.digest(recipe)
        item = copy.deepcopy(self.item)
        item['recipe_hash'] = rh
        directory = self.checkpoint / 'batches' / 'final'
        qa = {'passed': True, 'media_sha256': item['media_sha256'], 'recipe_hash': rh,
              'reviewer': 'gpt-6-luna', 'checks': {k: True for k in ('picture_verified', 'dialogue_verified', 'boundaries_verified', 'duration_verified', 'metadata_verified')},
              'release_gate': {'policy_version': 'snippy-luna-release-v1', 'passed': True, 'min_release_confidence': .95, 'release_confidence': .99, 'escalation_reasons': []}}
        audit.atomic(directory / 'recipe.json', recipe)
        audit.atomic(directory / 'final-qa.json', qa)
        record = {'status': 'published', 'final_directory': '/Users/original/production-1644/batches/final'}
        result = verifier.verify_local(self.checkpoint, record, item, self.reader.meta)
        self.assertEqual(result['status'], 'evidence_verified_media_not_transferred')
        qa['release_gate']['release_confidence'] = .94
        audit.atomic(directory / 'final-qa.json', qa)
        with self.assertRaisesRegex(ValueError, 'release gate'):
            verifier.verify_local(self.checkpoint, record, item, self.reader.meta)


if __name__ == '__main__':
    unittest.main()
