import csv
import json
from pathlib import Path
import tempfile
import unittest

import audit
from production_report import Reporter, sha


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ids = ['abcdefghijk', 'lmnopqrstuv']
        self.candidates = []
        for vid in self.ids:
            packet = {'candidate_id': vid, 'context': 'immutable'}
            self.write('input/candidates/' + vid + '.json', packet)
            self.candidates.append({'candidate_id': vid, 'lane': 'eligible', 'packet_sha256': audit.digest(packet)})
        self.write('input/manifest.json', {'candidates': self.candidates})

    def write(self, name, value):
        path = self.root / name
        audit.atomic(path, value)
        return path

    def report(self, verify=False, **kwargs):
        return Reporter(self.root, verify_media=verify, expected_count=2, checkpoint_counts=kwargs.pop('checkpoint_counts', (0, 0)), **kwargs).run()

    def hold(self, vid):
        return self.write('records/' + vid + '.json', {'candidate_id': vid, 'status': 'awaiting_astra',
            'stage': 'proposal', 'reason': 'Needs source review', 'packet_path': str(self.root / 'input/candidates' / (vid + '.json'))})

    def published(self, vid):
        directory = self.root / 'rendered' / (vid + '-sample')
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'clip.mp4').write_bytes(b'fixture media ' + vid.encode())
        media_hash = sha(directory / 'clip.mp4')
        recipe = {'candidate_id': vid, 'decision': 'approve'}
        self.write(str(directory / 'recipe.json'), recipe)
        self.write(str(directory / 'result.json'), {'output_sha256': media_hash})
        asr = self.write(str(directory / 'asr/clip.json'), {'words': [{'start': 0, 'end': 1, 'text': 'Hello'}]})
        self.write(str(directory / 'asr/evidence.json'), {'media_sha256': media_hash, 'asr_sha256': sha(asr)})
        self.write(str(directory / 'final-qa.json'), {'passed': True, 'media_sha256': media_hash,
            'recipe_hash': audit.digest(recipe), 'reviewer': 'Astra',
            'checks': dict.fromkeys(('picture_verified', 'dialogue_verified', 'boundaries_verified', 'duration_verified'), True)})
        receipt = self.write('publications/' + vid + '.json', {'passed': True, 'video_id': vid,
            'snippet_id': 'astra_' + vid, 'media_sha256': media_hash, 'recipe_hash': audit.digest(recipe),
            'uploaded_bytes': (directory / 'clip.mp4').stat().st_size,
            'query_jobs': [{'job_id': 'shared-job', 'bytes_billed': 100, 'cache_hit': False}]})
        self.write('records/' + vid + '.json', {'candidate_id': vid, 'status': 'published',
            'publication_receipt': str(receipt), 'final_directory': str(directory), 'directory': str(directory)})
        return directory, receipt

    def api(self, name='one', rid='resp_1', usage=None, raw=True, state=None, base='batches'):
        body = {'model': 'gpt-6-luna', 'input': name}
        directory = self.root / base / 'batch-1' / audit.digest(body)
        self.write(str(directory / 'request.json'), body)
        usage = usage if usage is not None else {'input_tokens': 100, 'output_tokens': 20,
            'input_tokens_details': {'cached_tokens': 30, 'cache_write_tokens': 20},
            'output_tokens_details': {'reasoning_tokens': 12}, 'total_tokens': 120}
        response = {'id': rid, 'model': 'gpt-6-luna', 'status': 'completed', 'usage': usage}
        if raw:
            self.write(str(directory / 'response.json'), response)
        if state:
            self.write(str(directory / 'call-state.json'), state)
        return directory, response

    def test_pending_ids_are_not_counted_done_and_csv_has_every_candidate(self):
        self.hold(self.ids[0])
        report = self.report()
        self.assertEqual(report['covered'], 1)
        self.assertEqual(report['remaining'], 1)
        self.assertEqual(report['pending_ids'], [self.ids[1]])
        self.assertFalse(report['all_completed'])
        self.assertFalse(report['passed'])
        with (self.root / 'coverage.csv').open(encoding='utf-8') as stream:
            self.assertEqual(len(list(csv.DictReader(stream))), 2)
        self.assertFalse(self.report(verify=True)['passed'])

    def test_astra_holds_are_disposed_but_not_complete(self):
        for vid in self.ids:
            self.hold(vid)
        report = self.report(verify=True)
        self.assertTrue(report['passed'], report['errors'])
        self.assertEqual(report['awaiting_astra'], 2)
        self.assertFalse(report['all_completed'])

    def test_duplicate_records_and_duplicate_manifest_fail(self):
        record = self.hold(self.ids[0])
        self.write('records/duplicate.json', json.loads(record.read_text()))
        report = self.report()
        self.assertFalse(report['integrity_passed'])
        self.assertIn('duplicate_unexpected_or_misnamed_record', [e['code'] for e in report['errors']])
        self.write('input/manifest.json', {'candidates': [self.candidates[0], self.candidates[0]]})
        report = self.report()
        self.assertIn('manifest_exact_inventory_failed', [e['code'] for e in report['errors']])
        self.assertEqual(len(report['coverage']), 1)

    def test_publication_receipts_and_full_media_hash_verification(self):
        first, receipt = self.published(self.ids[0])
        self.published(self.ids[1])
        self.assertTrue(self.report(verify=True)['passed'])
        (first / 'clip.mp4').write_bytes(b'modified media')
        self.assertTrue(self.report()['integrity_passed'])  # lightweight snapshot does not read media
        report = self.report(verify=True)
        self.assertFalse(report['passed'])
        self.assertIn('media_or_asr_binding_hash_drift', [e['code'] for e in report['errors']])
        receipt.unlink()
        self.assertFalse(self.report()['integrity_passed'])

    def test_packet_hash_and_asr_hash_errors_fail_final_verifier(self):
        directory, _ = self.published(self.ids[0])
        self.hold(self.ids[1])
        self.write('input/candidates/' + self.ids[0] + '.json', {'candidate_id': self.ids[0], 'changed': True})
        self.write(str(directory / 'asr/clip.json'), {'words': [{'start': 0, 'end': 1, 'text': 'tampered'}]})
        codes = [e['code'] for e in self.report(verify=True)['errors']]
        self.assertIn('candidate_packet_hash_drift', codes)
        self.assertIn('media_or_asr_binding_hash_drift', codes)

    def test_usage_cost_and_token_categories_are_deduplicated(self):
        _, raw = self.api()
        self.api(base='mac-checkpoint/batches')  # exact response copy, not another charged call
        report = self.report()
        self.assertEqual(report['api']['unique_responses'], 1)
        self.assertEqual(report['luna_cost_usd'], audit.price(raw))
        self.assertEqual(report['api']['token_categories']['input_tokens_details.cache_write_tokens'], 20)
        self.assertEqual(report['api']['token_categories']['output_tokens_details.reasoning_tokens'], 12)
        self.assertEqual(report['api']['checkpoint_usage_derived_cost_usd'], audit.price(raw))

    def test_unknown_charge_separate_from_known_usage(self):
        _, raw = self.api()
        self.api(name='unknown', raw=False, state={'status': 'unknown_charge'})
        self.api(name='429', raw=False, state={'status': 'rate_limited'})
        report = self.report()
        self.assertEqual(report['luna_cost_usd'], audit.price(raw))
        self.assertEqual(len(report['api']['unknown_charge_requests']), 1)
        self.assertEqual(len(report['api']['requests_without_response']), 2)
        self.assertFalse(report['checks']['no_unknown_charge_requests'])

    def test_response_conflict_and_malformed_usage_report_errors(self):
        self.api()
        self.api(name='duplicate-response-id', usage={'input_tokens': 999, 'output_tokens': 1})
        self.api(name='bad-usage', rid='resp_bad', usage={'input_tokens': 10, 'output_tokens': 1,
            'input_tokens_details': {'cached_tokens': 'not a number'}})
        report = self.report()
        codes = [e['code'] for e in report['errors']]
        self.assertIn('conflicting_response_id', codes)
        self.assertIn('missing_api_usage_receipt', codes)
        self.assertIn('resp_bad', report['api']['unpriced_response_ids'])

    def test_transfer_and_bigquery_receipts_are_deduplicated(self):
        self.published(self.ids[0]); self.published(self.ids[1])
        transfer = {'upstream_body_bytes_read': 10, 'upstream_requested_bytes': 30,
            'conservative_response_bytes_upper_bound': 20, 'source_generation': '1', 'errors': []}
        self.write('rendered/a/transfer.json', transfer)
        self.write('mac-checkpoint/rendered/copy/transfer.json', transfer)
        report = self.report()
        self.assertEqual(report['gcs']['unique_transfer_receipts'], 1)
        self.assertEqual(report['gcs']['upstream_requested_bytes'], 30)
        self.assertEqual(report['bigquery']['unique_jobs'], 1)
        self.assertEqual(report['bigquery']['known_bytes_billed'], 100)

    def test_failed_publication_attempt_queries_and_unknown_billing_are_retained(self):
        self.write('publication-attempts/failed.json', {'status': 'in_progress', 'query_jobs': [
            {'job_id': 'failed-publish-query', 'bytes_billed': 500, 'cache_hit': False}]})
        self.write('preflight-query.json', {'query_job': 'preflight-unknown-billing', 'bytes_processed': 50})
        report = self.report()
        self.assertEqual(report['bigquery']['known_bytes_billed'], 500)
        self.assertEqual(report['bigquery']['unknown_billed_job_ids'], ['preflight-unknown-billing'])

    def test_source_and_other_failures_are_separate(self):
        self.write('records/' + self.ids[0] + '.json', {'candidate_id': self.ids[0], 'status': 'failed',
            'stage': 'preparation', 'error': 'Command failed'})
        self.write('rendered/' + self.ids[0] + '-attempt/transfer.json', {'errors': ['GCS source failed'],
            'requests': [{'pages': [{'status': 412}]}]})
        self.write('records/' + self.ids[1] + '.json', {'candidate_id': self.ids[1], 'status': 'failed',
            'stage': 'luna', 'error': 'unknown charge'})
        report = self.report()
        self.assertEqual(report['source_failed'], 1)
        self.assertEqual(report['other_failed'], 1)
        self.assertEqual(report['remaining'], 0)
        self.assertFalse(report['checks']['no_operational_failures'])

    def test_typed_isolated_source_failure_is_not_other_failed(self):
        reporter = Reporter(self.root, expected_count=2)
        row = {'candidate_id': self.ids[0], 'status': 'failed', 'stage': 'preparation',
               'error': 'generic typed source failure',
               'isolated_source_failure': 'source_container_truncated'}
        self.assertEqual(reporter.failure_kind(row), 'source_failed')

    def test_mac_checkpoint_hashes_and_reservation_are_preserved(self):
        vid = self.ids[0]
        record = self.hold(vid)
        original = json.loads(record.read_text())
        frozen = self.write('mac-checkpoint/records/' + vid + '.json', original)
        self.write('records/' + vid + '.json', {**original, 'checkpoint_origin': 'Mac',
            'checkpoint_record_sha256': sha(frozen)})
        self.write('prior-verification.json', {'passed': True, 'preserve_skip_ids': [vid]})
        report = self.report(checkpoint_counts=(0, 1))
        self.assertTrue(report['checkpoint']['preserved'], report['errors'])
        self.write('records/' + vid + '.json', {**original, 'status': 'prepared', 'checkpoint_origin': 'Mac',
            'checkpoint_record_sha256': sha(frozen)})
        report = self.report(checkpoint_counts=(0, 1))
        self.assertFalse(report['checkpoint']['preserved'])


if __name__ == '__main__':
    unittest.main()
