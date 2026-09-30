import copy
import json
from pathlib import Path
import tempfile
import unittest

import audit
import calibrate_luna as c


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.media, self.recipe = self.root / 'clip.mp4', self.root / 'recipe.json'
        self.media.write_bytes(b'actual fixture media')
        self.recipe.write_text('{"speaker":"Expert"}')
        self.hashes = {'media_sha256': c.sha(self.media), 'recipe_hash': audit.digest(c.read(self.recipe))}
        self.manifest = {'ids': ['one', 'two', 'three'], 'lanes': {'one': 'eligible', 'two': 'review', 'three': 'eligible'}, 'waves': [{'wave_id': 'wave-1', 'ids': ['one', 'two', 'three']}], 'not_rendered': {'two': 'missing footage'}}
        self.pipeline = {'run_hash': 'run1', 'cost_usd': .01, 'batch_response_ids': ['api1'], 'decisions': [{'candidate_id': 'one', 'status': 'pass', 'complete': True, 'attempts': 2, 'media_path': str(self.media), 'recipe_path': str(self.recipe), **self.hashes}]}
        self.astra = {'schema_version': 'snippy-astra-calibration-v1', 'review_phase': 'blind', 'blind_to_luna_decisions': True, 'clips': [{'candidate_id': 'one', 'verdict': 'fix_required', 'reason': 'Opening clipped', **self.hashes}]}
        self.write('final-qa.json', {'passed': True, **self.hashes})

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value))
        return path

    def compare(self, pipelines=None, reports=None):
        return c.compare(self.write('manifest.json', self.manifest), pipelines if pipelines is not None else [self.write('pipeline.json', self.pipeline)], reports if reports is not None else [self.write('astra.json', self.astra)])

    def test_false_approval_and_explicit_missing_render(self):
        result = self.compare()
        self.assertEqual(result['summary']['false_approvals'], 1)
        self.assertEqual(result['summary']['false_approval_rate'], 1)
        self.assertEqual([r['luna_status'] for r in result['rows']], ['pass', 'not_rendered', 'unreviewed'])
        self.assertEqual(result['cost_usd'], .01)
        c.save_report(result, self.root / 'report')
        self.assertTrue((self.root / 'report/paired-results.csv').exists())

    def test_wrong_astra_media_or_recipe_is_unreviewed(self):
        for field in self.hashes:
            original = self.astra['clips'][0][field]
            self.astra['clips'][0][field] = 'wrong'
            result = self.compare()
            self.assertEqual(result['rows'][0]['astra_blind_verdict'], 'unreviewed')
            self.assertIsNone(result['summary']['false_approval_rate'])
            self.astra['clips'][0][field] = original

    def test_artifact_drift_and_missing_receipt_never_pass(self):
        self.media.write_bytes(b'changed')
        result = self.compare()
        self.assertEqual(result['rows'][0]['luna_status'], 'invalid_artifact')
        self.assertEqual(result['rows'][0]['astra_blind_verdict'], 'unreviewed')
        self.media.write_bytes(b'actual fixture media')
        (self.root / 'final-qa.json').unlink()
        result = self.compare()
        self.assertEqual(result['rows'][0]['luna_status'], 'unverified_pass_claim')
        self.assertEqual(result['summary']['false_approvals'], 0)

    def test_discrepancy_cannot_rewrite_blind_failure(self):
        later = copy.deepcopy(self.astra)
        later.update(review_phase='discrepancy', blind_to_luna_decisions=False)
        later['clips'][0]['verdict'] = 'pass'
        result = self.compare(reports=[self.write('blind.json', self.astra), self.write('later.json', later)])
        self.assertEqual(result['rows'][0]['astra_blind_verdict'], 'fix_required')
        self.assertEqual(result['rows'][0]['discrepancy_review_verdict'], 'pass')
        self.assertEqual(result['summary']['false_approvals'], 1)

    def test_unspecified_independence_and_conflicting_reports_not_pass(self):
        legacy = copy.deepcopy(self.astra)
        legacy.pop('review_phase')
        result = self.compare(reports=[self.write('legacy.json', legacy)])
        self.assertEqual(result['rows'][0]['astra_blind_verdict'], 'unreviewed')
        conflict = copy.deepcopy(self.astra)
        conflict['clips'][0]['verdict'] = 'pass'
        result = self.compare(reports=[self.write('blind.json', self.astra), self.write('conflict.json', conflict)])
        self.assertEqual(result['rows'][0]['astra_blind_verdict'], 'conflicting_reports')
        self.assertIsNone(result['summary']['false_approval_rate'])

    def test_cost_deduplication_and_cross_run_overlap(self):
        first, second = self.write('pipeline1.json', self.pipeline), self.write('pipeline2.json', self.pipeline)
        self.assertEqual(self.compare(pipelines=[first, second])['cost_usd'], .01)
        other = copy.deepcopy(self.pipeline)
        other['run_hash'] = 'run2'
        result = self.compare(pipelines=[first, self.write('other.json', other)])
        self.assertIsNone(result['cost_usd'])
        self.assertIn('double-count', result['cost_warning'])

    def test_unnecessary_edits_need_original_hash_bound_judgment(self):
        original = self.root / 'original.mp4'
        original.write_bytes(b'original complete clip')
        self.manifest['originals'] = {'one': {'media_path': str(original), 'recipe_path': str(self.recipe)}}
        result = self.compare()
        self.assertTrue(result['rows'][0]['edited'])
        self.assertEqual(result['rows'][0]['unnecessary_edit'], 'unassessed')
        self.astra['clips'][0]['unnecessary_edit'] = {'verdict': 'yes', 'original_media_sha256': c.sha(original), 'original_recipe_hash': self.hashes['recipe_hash'], 'reason': 'Original already complete'}
        result = self.compare()
        self.assertEqual(result['summary']['unnecessary_edits_confirmed'], 1)
        self.astra['clips'][0]['unnecessary_edit']['original_media_sha256'] = 'wrong'
        self.assertEqual(self.compare()['summary']['unnecessary_edits_confirmed'], 0)

    def test_escalation_not_counted_as_false_approval(self):
        self.pipeline['decisions'][0].update(status='escalated', complete=False, attempts=5)
        result = self.compare()
        self.assertEqual(result['rows'][0]['luna_status'], 'escalated')
        self.assertEqual(result['summary']['false_approvals'], 0)
        self.assertIsNone(result['summary']['false_approval_rate'])


if __name__ == '__main__':
    unittest.main()
