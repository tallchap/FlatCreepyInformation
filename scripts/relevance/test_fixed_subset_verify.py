"""Offline regression tests for the exact-340 final verifier."""
from pathlib import Path
import tempfile
import unittest

import audit
import fixed_subset_verify as verifier


def write_json(path, value):
    audit.atomic(Path(path), value)


class FixedSubsetVerifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'run'
        self.continuation = self.base / 'continuation'
        self.continuation.mkdir(parents=True)

        self.candidates = [f'v{i:010}' for i in range(1644)]
        self.selected = self.candidates[:340]
        self.existing_outsider = self.candidates[340]
        self.absent_outsider = self.candidates[341]
        manifest = self.root / 'input/manifest.json'
        culls = self.root / 'input/culled-ids.json'
        write_json(manifest, {'candidates': [
            {'candidate_id': vid, 'lane': 'eligible'} for vid in self.candidates
        ]})
        write_json(culls, [{'video_id': vid} for vid in self.candidates[-915:]])

        selected_path = self.continuation / 'selected-ids.txt'
        selected_path.write_bytes(('\n'.join(self.selected) + '\n').encode('ascii'))
        evidence = self.root / 'evidence/astra-handoff.md'
        evidence.parent.mkdir(parents=True)
        evidence.write_text('Offline Astra handoff evidence.\n', encoding='utf-8')
        for vid in self.selected:
            write_json(self.root / 'records' / f'{vid}.json', {
                'candidate_id': vid,
                'status': 'awaiting_astra',
                'reason': 'Luna escalated for independent review',
                'handoff': 'evidence/astra-handoff.md',
            })
        outsider_path = self.root / 'records' / f'{self.existing_outsider}.json'
        write_json(outsider_path, {
            'candidate_id': self.existing_outsider,
            'status': 'published',
            'immutable': True,
        })

        auth = {
            'schema_version': 'snippy-fixed-subset-authorization-v1',
            'job_id': 'TEST-FIXED-SUBSET-VERIFY',
            'scope': 'fixed_subset_frozen_manifest',
            'manifest_sha256': verifier.sha(manifest),
            'original_manifest_sha256': verifier.sha(manifest),
            'culled_ids_sha256': verifier.sha(culls),
            'selected_ids_file': selected_path.name,
            'selected_ids_sha256': verifier.sha(selected_path),
            'candidate_count': 340,
            'paid_astra_authorized': False,
            'max_batch_members': 5,
            'batch_workers': 2,
            'render_slots': 2,
            'asr_slots': 1,
            'publication_writers': 1,
            'min_release_confidence': .95,
            'max_passes': 5,
        }
        auth['authorization_sha256'] = audit.digest(auth)
        auth_path = self.continuation / 'authorization.json'
        write_json(auth_path, auth)

        protected_hash = verifier.sha(outsider_path)
        plan = {
            'schema_version': 'snippy-fixed-subset-plan-v1',
            'continuation_id': auth['job_id'],
            'authorization_sha256': verifier.sha(auth_path),
            'selected_ids_sha256': verifier.sha(selected_path),
            'authorized_candidate_ids': self.selected,
            'authorized_candidate_count': 340,
            'candidate_ids': self.selected,
            'preflight_holds': [],
            'mixed_batch_inventories': [],
            'protected_record_sha256': {self.existing_outsider: protected_hash},
            'baseline_record_sha256': {self.existing_outsider: protected_hash},
            # Every manifest member outside the selected 340 is represented
            # exactly once: the one existing outsider above, then all absent
            # outsiders here.
            'protected_absent_ids': self.candidates[341:],
            'preserved_file_sha256': {},
        }
        plan['plan_sha256'] = audit.digest(plan)
        write_json(self.continuation / 'continuation-plan.json', plan)
        write_json(self.continuation / 'preflight-reconciliation.json', {})

        self.delivery = self.base / 'checkpoint-delivery'
        write_json(self.delivery / 'partition.json', {
            'new_fallback_ids_in_this_checkpoint': self.selected,
        })
        write_json(self.delivery / 'checkpoint-manifest.json', {
            'job_id': auth['job_id'],
        })
        delivery_state = {
            'schema_version': 'snippy-fixed-subset-checkpoint-state-v1',
            'job_id': auth['job_id'],
            'selected_ids_sha256': auth['selected_ids_sha256'],
            'baseline_delivered_fallback_ids': [],
            'baseline_delivery_evidence': [],
            'delivered_fallback_ids': self.selected,
            'deliveries': [{
                'delivered_at': '2026-10-01T00:00:00+00:00',
                'directory': str(self.delivery),
                'manifest_file_sha256': verifier.sha(self.delivery / 'checkpoint-manifest.json'),
                'new_fallback_ids': self.selected,
                'final': False,
            }],
        }
        delivery_state['state_sha256'] = audit.digest(delivery_state)
        write_json(self.continuation / 'fixed-subset-checkpoint-state.json', delivery_state)

    def error_codes(self, report):
        return [error['code'] for error in report['errors']]

    def test_valid_exact_340_terminal_fixture_passes(self):
        report = verifier.verify(self.root, self.continuation)

        self.assertTrue(report['passed'], report['errors'])
        self.assertEqual(report['requested'], 340)
        self.assertEqual(report['covered'], 340)
        self.assertEqual(report['remaining'], 0)
        self.assertEqual(report['disposition_counts'], {'awaiting_astra': 340})
        self.assertTrue(report['out_of_scope_unchanged'])
        self.assertTrue(report['no_remote_astra_calls'])
        self.assertTrue((self.continuation / 'final-verification.json').is_file())
        self.assertTrue((self.continuation / 'final-dispositions.csv').is_file())

    def test_changed_existing_outsider_fails(self):
        write_json(self.root / 'records' / f'{self.existing_outsider}.json', {
            'candidate_id': self.existing_outsider,
            'status': 'published',
            'immutable': False,
        })

        report = verifier.verify(self.root, self.continuation)

        self.assertFalse(report['passed'])
        self.assertIn('protected_record_changed', self.error_codes(report))
        self.assertFalse(report['out_of_scope_unchanged'])

    def test_new_protected_absent_outsider_fails(self):
        write_json(self.root / 'records' / f'{self.absent_outsider}.json', {
            'candidate_id': self.absent_outsider,
            'status': 'preparing',
        })

        report = verifier.verify(self.root, self.continuation)

        self.assertFalse(report['passed'])
        self.assertIn('protected_outsider_record_appeared', self.error_codes(report))
        self.assertFalse(report['out_of_scope_unchanged'])

    def test_incomplete_outsider_protection_cover_fails(self):
        plan_path = self.continuation / 'continuation-plan.json'
        plan = verifier.load(plan_path)
        omitted = plan['protected_absent_ids'].pop()
        plan.pop('plan_sha256')
        plan['plan_sha256'] = audit.digest(plan)
        write_json(plan_path, plan)

        report = verifier.verify(self.root, self.continuation)

        self.assertFalse(report['passed'])
        self.assertIn('protected_outsider_cover_invalid', self.error_codes(report))
        cover_error = next(error for error in report['errors']
                           if error['code'] == 'protected_outsider_cover_invalid')
        self.assertIn('not exact and disjoint', cover_error['error'])
        self.assertIn(omitted, set(self.candidates) - set(self.selected))
        self.assertFalse(report['out_of_scope_unchanged'])

    def test_overlapping_existing_and_absent_protection_fails(self):
        plan_path = self.continuation / 'continuation-plan.json'
        plan = verifier.load(plan_path)
        plan['protected_absent_ids'].append(self.existing_outsider)
        plan.pop('plan_sha256')
        plan['plan_sha256'] = audit.digest(plan)
        write_json(plan_path, plan)

        report = verifier.verify(self.root, self.continuation)

        self.assertFalse(report['passed'])
        self.assertIn('protected_outsider_cover_invalid', self.error_codes(report))
        self.assertIn('protected_outsider_record_appeared', self.error_codes(report))
        self.assertFalse(report['out_of_scope_unchanged'])

    def test_current_record_filename_outside_manifest_fails(self):
        rogue = 'rogue000000'
        write_json(self.root / 'records' / f'{rogue}.json', {
            'candidate_id': rogue,
            'status': 'published',
        })

        report = verifier.verify(self.root, self.continuation)

        self.assertFalse(report['passed'])
        self.assertIn('protected_outsider_cover_invalid', self.error_codes(report))
        self.assertIn('current_record_outside_manifest', self.error_codes(report))
        self.assertIn('current_record_not_authorized_or_protected', self.error_codes(report))
        self.assertFalse(report['out_of_scope_unchanged'])

    def test_missing_astra_evidence_fails(self):
        write_json(self.root / 'records' / f'{self.selected[0]}.json', {
            'candidate_id': self.selected[0],
            'status': 'awaiting_astra',
            'reason': 'Luna escalated for independent review',
            'handoff': 'evidence/does-not-exist.md',
        })

        report = verifier.verify(self.root, self.continuation)

        self.assertFalse(report['passed'])
        self.assertIn('selected_astra_evidence_missing', self.error_codes(report))

    def test_undelivered_fallback_evidence_fails(self):
        state_path = self.continuation / 'fixed-subset-checkpoint-state.json'
        state = verifier.load(state_path)
        missing = self.selected[0]
        remaining = self.selected[1:]
        write_json(self.delivery / 'partition.json', {
            'new_fallback_ids_in_this_checkpoint': remaining,
        })
        state['delivered_fallback_ids'] = remaining
        state['deliveries'][0]['new_fallback_ids'] = remaining
        state.pop('state_sha256')
        state['state_sha256'] = audit.digest(state)
        write_json(state_path, state)

        report = verifier.verify(self.root, self.continuation)

        self.assertFalse(report['passed'])
        self.assertIn('fallback_evidence_not_delivered', self.error_codes(report))
        self.assertIn(missing, next(error['candidate_ids'] for error in report['errors']
                                    if error['code'] == 'fallback_evidence_not_delivered'))

    def test_non_luna_response_fails(self):
        request = {'model': 'gpt-5.6-sol', 'input': 'forbidden remote review'}
        call = self.root / 'batches/batch-001' / audit.digest(request)
        write_json(call / 'request.json', request)
        write_json(call / 'response.json', {
            'id': 'resp_non_luna',
            'model': 'gpt-5.6-sol',
            'status': 'completed',
            'usage': {
                'input_tokens': 10,
                'output_tokens': 5,
                'input_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': 0},
            },
        })

        report = verifier.verify(self.root, self.continuation)

        self.assertFalse(report['passed'])
        self.assertIn('non_luna_model_receipts', self.error_codes(report))
        self.assertFalse(report['no_remote_astra_calls'])


if __name__ == '__main__':
    unittest.main()
