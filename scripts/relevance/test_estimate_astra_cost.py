import json
from pathlib import Path
import tempfile
import unittest

import estimate_astra_cost as e


class CostTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cohorts = {'candidate01': {'cohort': 'calibration20', 'lane': 'review', 'wave': 1}}

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
        return path

    def test_api_cost_counts_failed_normalization_and_dedupes_response_copies(self):
        raw = {'id': 'response1', 'model': 'gpt-6-luna', 'status': 'completed', 'usage': {'input_tokens': 1000, 'output_tokens': 100}}
        for folder in ('first', 'copied'):
            self.write(folder + '/response.json', raw)
            self.write(folder + '/packages.json', [{'evidence': {'candidate_id': 'candidate01'}}])
            self.write(folder + '/request.json', {'instructions': 'You are the Luna FINALIZER'})
        result = e.collect_api(self.root, self.cohorts)
        self.assertEqual(result['response_count'], 1)
        self.assertAlmostEqual(result['cost_usd'], .00015)
        self.assertEqual(result['cost_usd'], result['without_normalization_receipt_usd'])
        self.assertEqual(result['by_cohort_lane_wave'][0]['cohort'], 'calibration20')

    def test_transfer_retry_counts_but_copies_and_result_headers_do_not(self):
        first = {'upstream_body_bytes_read': 100, 'conservative_response_bytes_upper_bound': 200, 'errors': ['network'], 'requests': [{'started_at': 'first'}]}
        retry = {**first, 'upstream_body_bytes_read': 150, 'errors': [], 'requests': [{'started_at': 'retry'}]}
        for folder, receipt in [('original', first), ('copied', first), ('retry', retry)]:
            self.write(folder + '/transfer.json', receipt)
            self.write(folder + '/recipe.json', {'candidate_id': 'candidate01'})
        self.write('trim/result.json', {'transfer': first, 'additional_gcs_bytes_read': 0})
        result = e.collect_transfers(self.root, self.cohorts)
        self.assertEqual(result['totals']['attempts'], 2)
        self.assertEqual(result['totals']['failed_attempts'], 1)
        self.assertEqual(result['totals']['additional_attempts_including_retries'], 1)
        self.assertEqual(result['totals']['bytes_read'], 250)
        self.assertEqual(result['totals']['response_bytes_upper_bound'], 400)

    def test_missing_transfer_meter_is_exposed_not_estimated_zero(self):
        self.write('calibration20/network-failures/candidate01.json', {'candidate_id': 'candidate01', 'error': 'network'})
        result = e.collect_transfers(self.root, self.cohorts)
        self.assertEqual(len(result['unmetered_failure_reports']), 1)
        self.assertEqual(result['totals']['attempts'], 0)

    def test_repeated_experiments_do_not_inflate_distinct_sample_size(self):
        decisions = [{'candidate_id': f'{lane}{n}', 'lane': lane, 'allocated_model_usd': .001, 'first_round_model_usd': .001, 'status': 'pass', 'attempts': 1} for lane in ('eligible', 'review') for n in range(2)]
        runs = [{'prompt_version': 'version1', 'run_hash': str(i), 'created_at': str(i), 'role_prompt_hashes': {'finalizer': 'f', 'verifier': 'v'}, 'decisions': decisions} for i in range(3)]
        version = e.prompt_versions(runs)[0]
        self.assertFalse(version['enough_for_latest_baseline'])
        self.assertEqual(version['by_lane']['review']['distinct_clips'], 2)
        self.assertEqual(version['by_lane']['review']['clip_runs'], 6)
        for lane in ('eligible', 'review'):
            decisions.append({'candidate_id': lane + '2', 'lane': lane, 'allocated_model_usd': .001, 'first_round_model_usd': .001, 'status': 'pass', 'attempts': 1})
        self.assertTrue(e.prompt_versions(runs)[0]['enough_for_latest_baseline'])

    def test_projection_excludes_missing_footage(self):
        candidates = [{'lane': lane, 'source_duration_seconds': 1000, 'luna_proposal': {'start_seconds': 100, 'end_seconds': 130}, 'gcs_object': {'size': '100000000'}} for lane in ('eligible', 'review')]
        candidates.append({**candidates[0], 'gcs_object': None})
        measurements = [{'lane': lane, 'extra_read_bytes_including_retries': 1000, 'final_duration_to_proposal_ratio': 1, 'output_size_to_source_payload_ratio': 1} for lane in ('eligible', 'review')]
        version = {'prompt_version': 'v', 'enough_for_latest_baseline': False, 'by_lane': {lane: {'mean_luna_usd_per_clip_run': .001, 'mean_first_round_usd': .001, 'distinct_clips': 1} for lane in ('eligible', 'review')}}
        result = e.project(candidates, version, measurements)
        self.assertEqual(result['totals']['candidates'], 2)
        self.assertEqual(result['rows'][0]['skipped_missing_source'], 1)
        self.assertFalse(result['sufficient_sample'])


if __name__ == '__main__':
    unittest.main()
