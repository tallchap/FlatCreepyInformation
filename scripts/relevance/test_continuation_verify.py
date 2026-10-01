import copy
import json
from pathlib import Path
import tempfile
import unittest

import audit
from production_report import sha
from continuation_verify import baseline_checks, copy_raw_responses, response_model_errors, terminal_errors


class FinalContinuationVerificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'run'
        self.cont = Path(self.tmp.name) / 'continuation'
        self.checkpoint = Path(self.tmp.name) / 'checkpoint'
        self.root.mkdir(); self.cont.mkdir(); self.checkpoint.mkdir()

    def write(self, path, value):
        audit.atomic(path, value)
        return path

    def baseline(self):
        manifest = self.write(self.root / 'input/manifest.json', {'candidates': []})
        record = self.write(self.root / 'records/protected.json', {'candidate_id': 'protected', 'status': 'awaiting_astra'})
        plan = self.write(self.root / 'batches/old/batch-plan.json', {'candidate_ids': ['paid'], 'slot_candidate_ids': ['paid', 'transient']})
        self.write(self.checkpoint / 'artifacts/batches/old/batch-plan.json', json.loads(plan.read_text()))
        cp = self.write(self.checkpoint / 'manifest.json', {'files': [
            {'path': 'artifacts/input/manifest.json', 'sha256': sha(manifest)},
            {'path': 'artifacts/batches/old/batch-plan.json', 'sha256': sha(plan)}]})
        self.write(self.checkpoint / 'response-usage.json', {'responses': []})
        return {'passed': True, 'candidate_count': 1644, 'input_manifest': {'sha256': sha(manifest)},
                'checkpoint_manifest': {'sha256': sha(cp)}, 'acknowledged_checkpoint': str(self.checkpoint),
                'protected': {'protected': {'record': {'sha256': sha(record)}, 'receipts': {}}},
                'all_prior_record_sha256': {'protected': sha(record)}, 'failure_recovery': []}

    def report(self):
        return {'coverage': [{'candidate_id': str(i), 'status': 'source_failed', 'reason': '404 source unavailable'} for i in range(1644)],
                'api': {'unknown_charge_requests': [], 'unpriced_response_ids': []}}

    def response(self, rid='resp_123', extra=None):
        raw = {'id': rid, 'model': 'gpt-6-luna', 'usage': {'input_tokens': 100, 'output_tokens': 1}, 'output': []}
        raw.update(extra or {})
        p = self.write(self.root / 'batches/one/hash/response.json', raw)
        return {'response_id': rid, 'response_paths': [str(p)], 'response_sha256': audit.digest(raw), 'usage_derived_cost_usd': .01}

    def test_all_explicit_source_failures_are_terminal_without_claiming_publication(self):
        self.assertEqual(terminal_errors(self.report()), [])

    def test_pending_and_unknown_charges_fail(self):
        r = self.report(); r['coverage'][0]['status'] = 'paused'
        r['api']['unknown_charge_requests'] = [{'request_hash': 'x', 'charge_unknown': True}]
        self.assertEqual({x['code'] for x in terminal_errors(r)}, {'nonterminal_candidates_remaining', 'unknown_charge_requests_unresolved'})

    def test_exact_unique_inventory_and_failure_reasons_required(self):
        r = self.report(); r['coverage'][0]['candidate_id'] = '1'; r['coverage'][0]['reason'] = None
        self.assertEqual({x['code'] for x in terminal_errors(r)}, {'final_coverage_not_exact_1644', 'failure_without_explicit_reason'})

    def test_protected_astra_record_is_immutable(self):
        b = self.baseline()
        self.assertEqual(baseline_checks(self.root, self.cont, b, {})['errors'], [])
        self.write(self.root / 'records/protected.json', {'candidate_id': 'protected', 'status': 'published'})
        self.assertIn('protected_prior_record_changed', {e['code'] for e in baseline_checks(self.root, self.cont, b, {})['errors']})

    def test_old_paid_membership_cannot_be_recovered_under_new_group(self):
        b = self.baseline()
        b['failure_recovery'] = [{'candidate_id': 'paid', 'retry_authorized_if_full_gates_rechecked': True, 'record_sha256': 'x'}]
        a = {'recoverable_failed_ids': ['paid']}
        result = baseline_checks(self.root, self.cont, b, a)
        self.assertIn('recovery_would_regroup_paid_member', {e['code'] for e in result['errors']})

    def test_manifest_and_old_plan_changes_fail(self):
        b = self.baseline()
        self.write(self.root / 'input/manifest.json', {'candidates': ['changed']})
        self.write(self.root / 'batches/old/batch-plan.json', {'candidate_ids': []})
        codes = {e['code'] for e in baseline_checks(self.root, self.cont, b, {})['errors']}
        self.assertIn('input_manifest_changed', codes)
        self.assertIn('immutable_input_or_plan_changed', codes)

    def test_models_scan_requests_even_without_responses(self):
        self.write(self.root / 'batches/a/b/request.json', {'model': 'gpt-6-astra'})
        self.assertEqual(response_model_errors(self.root)[0]['code'], 'non_luna_model_receipt')

    def test_export_copies_response_bytes_and_no_request(self):
        row = self.response()
        self.write(self.root / 'batches/one/hash/request.json', {'large_request_secret': 'do not export'})
        exported, errors = copy_raw_responses({'responses': [row]}, self.cont / 'raw')
        self.assertEqual(errors, [])
        self.assertEqual(Path(exported[0]['path']).read_bytes(), Path(row['response_paths'][0]).read_bytes())
        self.assertEqual(len(list((self.cont / 'raw').iterdir())), 2)
        self.assertFalse(any('request' in p.read_text() for p in (self.cont / 'raw').iterdir()))

    def test_export_rejects_receipt_drift_and_credential_payload(self):
        row = self.response(); row['response_sha256'] = 'wrong'
        self.assertTrue(copy_raw_responses({'responses': [row]}, self.cont / 'raw')[1])
        row = self.response(extra={'output': [{'text': 'sk-proj-abcdefghijklmno'}]})
        self.assertTrue(copy_raw_responses({'responses': [row]}, self.cont / 'raw')[1])

    def test_raw_response_export_is_immutable(self):
        row = self.response()
        items, errors = copy_raw_responses({'responses': [row]}, self.cont / 'raw')
        self.assertFalse(errors)
        Path(items[0]['path']).write_text('{}')
        self.assertTrue(copy_raw_responses({'responses': [row]}, self.cont / 'raw')[1])


if __name__ == '__main__':
    unittest.main()
