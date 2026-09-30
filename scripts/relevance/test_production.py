import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
import production as p


class ProductionTests(unittest.TestCase):
    def fixture(self):
        source = {'transcript': '\n'.join(f'[{i}] word{i}' for i in range(0, 401, 10))}
        packet = {'candidate_id': 'abcdefghijk', 'source_input_hash': 'hash', 'title': 'AI',
                  'speaker_source': 'Speaker', 'luna_reason': 'AI claim', 'source_duration_seconds': 400,
                  'context_start_seconds': 0, 'context_end_seconds': 400,
                  'luna_proposal': {'start_seconds': 21, 'end_seconds': 61, 'claim': 'AI claim'}}
        return packet, source

    def test_outward_alignment_includes_all_captions_but_is_provisional(self):
        packet, source = self.fixture()
        recipe = p.seed(packet, source)
        edit = recipe['edits'][0]
        self.assertLessEqual(edit['start_seconds'], 21)
        self.assertGreaterEqual(edit['end_seconds'], 61)
        self.assertIn('PROVISIONAL', recipe['reason'])
        self.assertEqual(edit['transcript'], ' '.join(f'word{i}' for i in range(int(edit['start_seconds']), int(edit['end_seconds']), 10)))

    def test_never_silently_shrinks_an_oversize_proposal(self):
        packet, source = self.fixture()
        packet['luna_proposal'].update(start_seconds=0, end_seconds=241)
        with self.assertRaisesRegex(ValueError, '240'):
            p.seed(packet, source)

    def test_maximum_clip_does_not_get_padding_past_limit(self):
        packet, source = self.fixture()
        packet['luna_proposal'].update(start_seconds=20, end_seconds=260)
        edit = p.seed(packet, source)['edits'][0]
        self.assertEqual(edit['end_seconds'] - edit['start_seconds'], 240)

    def test_bad_timestamps_fail_closed(self):
        for a, b in [(float('nan'), 60), (-1, 60), (60, 60), (60, float('inf'))]:
            packet, source = self.fixture()
            packet['luna_proposal'].update(start_seconds=a, end_seconds=b)
            with self.subTest(a=a, b=b), self.assertRaises(ValueError):
                p.seed(packet, source)

    def test_live_receipt_rejects_missing_database_row(self):
        receipt = {'video_id': 'abcdefghijk', 'snippet_id': 'id', 'gcs_url': 'https://example.com/clip.mp4'}
        response = Mock(); response.json.return_value = []
        with patch('production.requests.get', return_value=response) as get:
            with self.assertRaisesRegex(ValueError, 'missing'):
                p.live_receipt(receipt)
            self.assertEqual(get.call_count, 1)

    def test_unresolved_is_coverage_but_not_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p.audit.atomic(root / 'input/manifest.json', {'candidates': [{'candidate_id': 'abcdefghijk'}]})
            p.audit.atomic(root / 'records/abcdefghijk.json', {'candidate_id': 'abcdefghijk', 'status': 'awaiting_astra'})
            result = p.verify(root)
            self.assertTrue(result['checks']['exact_coverage'])
            self.assertFalse(result['passed'])


if __name__ == '__main__':
    unittest.main()
