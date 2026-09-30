import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import audit
import calibrate_luna
import check_calibration_goal as goal
from process_astra import sha


class GoalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.manifest = {'candidates': [
            {'candidate_id': f'clip-{i}', 'wave': 1 if i < 10 else 2 if i < 20 else 3,
             'lane': 'eligible' if i % 2 == 0 else 'review'} for i in range(25)]}
        self.pipelines = {2: {'run_hash': 'selected-wave-2', 'decisions': []},
                          3: {'run_hash': 'selected-wave-3', 'decisions': []}}
        self.astra = {'review_phase': 'blind', 'blind_to_luna_decisions': True, 'clips': []}
        for i in range(10, 25):
            directory = self.root / f'clip-{i}'
            directory.mkdir()
            media = directory / 'clip.mp4'
            media.write_bytes(f'fixture media {i}'.encode())
            recipe = directory / 'recipe.json'
            self.write(recipe, {'candidate_id': f'clip-{i}', 'title': 'Title'})
            hashes = {'media_sha256': sha(media), 'recipe_hash': audit.digest(json.loads(recipe.read_text()))}
            self.write(directory / 'final-qa.json', {'passed': True, **hashes})
            self.pipelines[2 if i < 20 else 3]['decisions'].append({
                'candidate_id': f'clip-{i}', 'status': 'pass', 'complete': True, 'attempts': 1,
                'media_path': str(media), 'recipe_path': str(recipe), **hashes})
            self.astra['clips'].append({'candidate_id': f'clip-{i}', 'verdict': 'pass', 'reason': 'Clear', **hashes})
        self.refresh()

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, data):
        path.write_text(json.dumps(data))
        return path

    def refresh(self):
        self.manifest_path = self.write(self.root / 'manifest.json', self.manifest)
        paths = [self.write(self.root / f'pipeline-{wave}.json', value) for wave, value in self.pipelines.items()]
        astra_path = self.write(self.root / 'astra.json', self.astra)
        self.comparison = calibrate_luna.compare(self.manifest_path, paths, [astra_path])
        self.pairs = list(zip(paths, self.pipelines.values()))

    def check(self):
        return goal.check_goal(self.manifest, self.comparison, self.pairs)

    def test_fifteen_passes_excludes_unreviewed_training(self):
        result = self.check()
        self.assertTrue(result['target_met'], result['errors'])
        self.assertEqual(result['denominator'], 15)
        self.assertEqual(result['successful_clips'], 15)
        self.assertEqual(result['cap']['total_selected'], 30)
        self.assertEqual(result['exit_code'], 0)

    def test_fourteen_of_fifteen_never_rounds_to_95(self):
        self.pipelines[3]['decisions'][-1].update(status='escalated', complete=False)
        self.refresh()
        result = self.check()
        self.assertFalse(result['target_met'])
        self.assertEqual(result['successful_clips'], 14)
        self.assertEqual(result['denominator'], 15)
        self.assertEqual(result['success_fraction'], 14 / 15)
        self.assertEqual(result['escalations'], 1)
        self.assertEqual(result['false_approvals'], 0)

    def test_unreviewed_never_counts_as_success(self):
        self.astra['clips'].pop()
        self.refresh()
        result = self.check()
        self.assertFalse(result['target_met'])
        self.assertFalse(result['all_selected_evaluated'])
        self.assertEqual(result['successful_clips'], 14)
        self.assertEqual(result['unreviewed_or_invalid'], 1)

    def test_duplicate_candidate_rows_fail_without_inflating_successes(self):
        row = next(x for x in self.comparison['rows'] if x.get('run_hash') == 'selected-wave-2')
        self.comparison['rows'].append(copy.deepcopy(row))
        result = self.check()
        self.assertFalse(result['target_met'])
        self.assertEqual(result['successful_clips'], 15)
        self.assertEqual(result['denominator'], 15)
        self.assertTrue(any(x['check'] == 'unique_comparison_candidates' and not x['passed'] for x in result['checks']))

    def test_selected_rerun_fails_and_old_unselected_run_is_ignored(self):
        old = copy.deepcopy(self.comparison['rows'][0])
        old['run_hash'] = 'old-prompt-run'
        old['astra_blind_verdict'] = 'unreviewed'
        self.comparison['rows'].append(old)
        self.assertTrue(self.check()['target_met'])
        rerun = copy.deepcopy(self.pipelines[2])
        rerun['run_hash'] = 'rerun'
        self.pairs.append((self.root / 'rerun.json', rerun))
        result = self.check()
        self.assertFalse(result['target_met'])
        self.assertTrue(any(x['check'] == 'unique_selected_candidates' and not x['passed'] for x in result['checks']))

    def test_previously_blind_reviewed_rerun_is_not_fresh(self):
        old = copy.deepcopy(self.comparison['rows'][0])
        old['run_hash'] = 'prior-reviewed-run'
        self.comparison['rows'].append(old)
        result = self.check()
        self.assertFalse(result['target_met'])
        self.assertEqual(result['successful_clips'], 14)
        self.assertEqual(result['previously_reviewed_candidate_ids'], ['clip-10'])

    def test_31_cap_and_duplicate_manifest_fail(self):
        self.manifest['candidates'].append({'candidate_id': 'extra', 'wave': 3, 'lane': 'review'})
        result = self.check()
        self.assertFalse(result['target_met'])
        self.assertEqual(result['cap']['total_selected'], 31)
        self.assertTrue(any(x['check'] == 'hard_cap_30' and not x['passed'] for x in result['checks']))
        self.manifest['candidates'].pop()
        self.manifest['candidates'][0]['candidate_id'] = self.manifest['candidates'][1]['candidate_id']
        self.assertFalse(self.check()['target_met'])

    def test_original_pilot_cannot_be_fresh(self):
        self.manifest['candidates'][-1]['candidate_id'] = next(iter(goal.ORIGINAL_PILOTS))
        self.assertFalse(self.check()['target_met'])

    def test_false_approval_and_fallback_are_separate(self):
        self.astra['clips'][0]['verdict'] = 'fix_required'
        self.pipelines[3]['decisions'][-1].update(status='manual_fallback', complete=False, fallback_used=True)
        self.refresh()
        result = self.check()
        self.assertFalse(result['target_met'])
        self.assertEqual(result['false_approvals'], 1)
        self.assertEqual(result['explicit_fallbacks'], 1)
        self.assertEqual(result['escalations'], 0)

    def test_changed_media_and_recipe_never_pass(self):
        media = self.root / 'clip-10/clip.mp4'
        media.write_bytes(b'drift')
        self.assertFalse(self.check()['target_met'])
        self.assertEqual(self.check()['successful_clips'], 14)

    def test_blind_report_drift_and_qa_receipt_drift_fail(self):
        changed = copy.deepcopy(self.astra)
        changed.update(review_phase='discrepancy', blind_to_luna_decisions=False)
        self.write(self.root / 'astra.json', changed)
        self.assertFalse(self.check()['target_met'])
        self.write(self.root / 'astra.json', self.astra)
        self.write(self.root / 'clip-10/final-qa.json', {'passed': True, 'media_sha256': 'wrong'})
        self.assertFalse(self.check()['target_met'])

    def test_cli_writes_reports_and_exits_nonzero_for_missing_review(self):
        self.astra['clips'].pop()
        self.refresh()
        cp = self.write(self.root / 'calibration.json', self.comparison)
        result = subprocess.run([sys.executable, str(Path(goal.__file__)), '--manifest', str(self.manifest_path),
                                 '--calibration', str(cp), '--pipelines', *[str(p) for p, _ in self.pairs]],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue((self.root / 'goal-verification.md').is_file())
        report = json.loads((self.root / 'goal-verification.json').read_text())
        self.assertFalse(report['target_met'])


if __name__ == '__main__':
    unittest.main()
