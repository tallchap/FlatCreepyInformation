import tempfile
from pathlib import Path
import unittest

import audit
import cloud_usage as cloud


class CloudUsageTests(unittest.TestCase):
    def fixture(self, root):
        ids = [f'wave{i}' for i in range(50)]
        initial = [f'prior{i}' for i in range(5)]
        plan = {'experiment_id': 'wave-one', 'candidate_ids': ids,
                'baseline_record_sha256': {vid: 'baseline' for vid in initial},
                'slots': [{'batch_name': f'group{i}', 'candidate_ids': ids[i*5:i*5+5]} for i in range(10)]}
        plan['plan_sha256'] = audit.digest(plan)
        audit.atomic(root / 'experiment-plan.json', plan)
        audit.atomic(root / 'experiment-status.json', {'experiment_id': 'wave-one', 'phase': 'paused', 'drained_at': audit.now()})
        audit.atomic(root / 'batches/initial/batch-plan.json', {'slot_candidate_ids': initial})
        for vid in initial:
            audit.atomic(root / 'records' / f'{vid}.json', {'candidate_id': vid, 'status': 'awaiting_astra'})
        audit.atomic(root / 'storage-metadata.json', {'name': cloud.BUCKET, 'status': 'failed', 'http_status': 403, 'explicit_request_count': 1})
        audit.atomic(root / 'preflight-query.json', {'query_jobs': [{'job_id': 'historical', 'bytes_billed': 10**15}]})
        return plan

    def receipt(self, root, vid, job_id, amount=10485760):
        audit.atomic(root / 'publications' / f'{vid}.json', {'passed': True, 'video_id': vid,
            'uploaded_bytes': 1024, 'gcs_generation': '100', 'gcs_url': f'https://storage.googleapis.com/{cloud.BUCKET}/{vid}.mp4',
            'media_sha256': vid, 'query_jobs': [{'job_id': job_id, 'bytes_billed': amount, 'cache_hit': False}],
            'query_bytes_billed': amount})

    def test_scoped_queries_deduplicate_attempt_receipts_and_exclude_historical_and_other_scopes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            self.receipt(root, 'wave0', 'fresh')
            self.receipt(root, 'prior0', 'first', 20)
            self.receipt(root, 'unrelated', 'outside', 10**12)
            audit.atomic(root / 'publication-attempts/wave0.json', {'candidate_id': 'wave0', 'status': 'verified',
                'query_jobs': [{'job_id': 'fresh', 'bytes_billed': 10485760, 'cache_hit': False}]})
            current = cloud.Usage(root).build()
            self.assertEqual(current['bigquery']['unique_publication_query_jobs'], 1)
            self.assertEqual(current['bigquery']['recorded_bytes_billed'], 10485760)
            self.assertEqual(current['outputs']['unique_verified_objects'], 1)
            first = cloud.Usage(root, scope='first-shadow').build()
            self.assertEqual(first['scope']['candidate_count'], 5)
            self.assertEqual(first['bigquery']['recorded_bytes_billed'], 20)

    def test_copied_transfer_is_not_counted_again_and_403_is_not_a_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            transfer = {'source_generation': 'g', 'upstream_body_bytes_read': 5,
                'conservative_response_bytes_upper_bound': 10, 'upstream_requested_bytes': 10,
                'requests': [{'pages': [{'status': 206, 'bytes_read': 5, 'requested_bytes': 10}]}]}
            for suffix in ('original', 'copied'):
                directory = root / 'rendered' / ('wave0-' + suffix)
                audit.atomic(directory / 'recipe.json', {'candidate_id': 'wave0'})
                audit.atomic(directory / 'transfer.json', transfer)
                audit.atomic(directory / 'source.json', {'bucket': cloud.BUCKET, 'generation': 'g', 'storageClass': 'STANDARD'})
            report = cloud.Usage(root).build()
            self.assertEqual(report['source_downloads']['body_bytes_read'], 5)
            self.assertEqual(report['source_downloads']['range_http_responses_observed'], 1)
            self.assertIsNone(report['bucket']['location'])
            self.assertFalse(report['bucket']['metadata_verified'])
            self.assertIsNone(report['costs']['cloud_invoice_usd'])
            self.assertIsNone(report['costs']['cloud_estimate_usd'])
            calc = report['costs']['illustrative_calculator']
            self.assertTrue(calc['not_an_invoice_or_account_cost_bound'])
            self.assertEqual(calc['source_egress']['read_bytes_scenario_usd'], 5 / 1024**3 * .12)

    def test_conflicting_billing_and_missing_billing_stay_visible(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            self.receipt(root, 'wave0', 'conflict', 10)
            audit.atomic(root / 'publication-attempts/wave0.json', {'candidate_id': 'wave0', 'query_jobs': [
                {'job_id': 'conflict', 'bytes_billed': 20, 'cache_hit': False},
                {'job_id': 'unknown', 'bytes_billed': None, 'cache_hit': None}]})
            report = cloud.Usage(root).build()
            self.assertFalse(report['checks']['evidence_integrity'])
            self.assertFalse(report['checks']['query_billing_fields_complete'])
            self.assertEqual(report['bigquery']['unknown_or_ambiguous_billing_job_ids'], ['unknown'])

    def test_cached_pages_are_local_bytes_not_gcs_operations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            directory = root / 'rendered/wave0-cached'
            audit.atomic(directory / 'recipe.json', {'candidate_id': 'wave0'})
            audit.atomic(directory / 'transfer.json', {'source_generation': 'g',
                'upstream_body_bytes_read': 0, 'conservative_response_bytes_upper_bound': 0,
                'upstream_requested_bytes': 0, 'original_cache_body_bytes_read': 100,
                'original_cache_page_hits': 1, 'requests': [{'pages': [
                    {'cache_hit': True, 'status': 206, 'bytes_read': 100, 'requested_bytes': 0}]}]})
            report = cloud.Usage(root).build()
            self.assertTrue(report['checks']['evidence_integrity'])
            self.assertEqual(report['source_downloads']['body_bytes_read'], 0)
            self.assertEqual(report['source_downloads']['original_cache_body_bytes_read'], 100)
            self.assertEqual(report['operations']['source_range_http_responses_observed'], 0)
            self.assertEqual(report['operations']['source_range_request_intents'], 0)

    def test_tiny_scope_prices_only_its_saved_responses_and_preserves_unknowns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            ids = ['tiny0', 'tiny1', 'tiny2', 'tiny3', 'tiny4']
            plan = {'stream_id': 'tiny-trial', 'target_candidate_count': 5, 'candidate_ids': ids,
                'baseline_record_sha256': {}, 'slots': [{'batch_name': 'tiny-eligible', 'candidate_ids': ids[:3]},
                                                       {'batch_name': 'tiny-review', 'candidate_ids': ids[3:]}]}
            plan['plan_sha256'] = audit.digest(plan)
            audit.atomic(root / 'stream-plan.json', plan)
            audit.atomic(root / 'stream-status.json', {'stream_id': 'tiny-trial', 'phase': 'stream_completed'})
            raw = {'id': 'resp-tiny', 'model': 'gpt-6-luna', 'usage': {'input_tokens': 1000, 'output_tokens': 100}}
            audit.atomic(root / 'batches/tiny-eligible/r/response.json', raw)
            audit.atomic(root / 'batches/group0/other/response.json', {**raw, 'id': 'outside'})
            audit.atomic(root / 'batches/tiny-review/u/call-state.json', {'status': 'unknown_charge'})
            audit.atomic(root / 'batches/tiny-review/c/call-state.json', {'status': 'cancelled_before_dispatch', 'dispatched': False})
            report = cloud.Usage(root, scope='stream').build()
            self.assertEqual(report['scope']['candidate_count'], 5)
            self.assertEqual(report['costs']['model_api_usage_derived_usd'], audit.price(raw))
            self.assertEqual(report['costs']['model_response_ids'], ['resp-tiny'])
            self.assertEqual(len(report['costs']['model_unknown_charge_paths']), 1)
            self.assertTrue(report['checks']['wave_finished'])


if __name__ == '__main__':
    unittest.main()
