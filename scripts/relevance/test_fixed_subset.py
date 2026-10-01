"""Offline regressions for exact, hash-bound subset admission."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import production as p
import migrate_fixed_subset_plan_inventory as migration


class FixedSubsetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root, self.cont = self.base / 'run', self.base / 'continuation'
        self.job = 'TEST-SELECTED340-LUNA-20261001'
        self.candidates = [{'candidate_id': f'v{i:010}', 'lane': 'eligible' if i < 1100 else 'review'}
                           for i in range(1644)]
        p.audit.atomic(self.root / 'input/manifest.json', {'candidates': self.candidates})
        p.audit.atomic(self.root / 'input/already-published.json', {})
        p.audit.atomic(self.root / 'input/culled-ids.json', [{'video_id': self.candidates[-1]['candidate_id']}])
        p.audit.atomic(self.root / 'checkpoint-import.json', {
            'original_manifest_sha256': p.luna.sha(self.root / 'input/manifest.json')})
        self.ids = [row['candidate_id'] for row in self.candidates[:340]]
        self.cont.mkdir()
        self.ids_path = self.cont / 'selected-ids.txt'
        self.ids_path.write_bytes(('\n'.join(self.ids) + '\n').encode('ascii'))
        for vid in self.ids:
            p.audit.atomic(self.root / 'input/candidates' / f'{vid}.json', {'candidate_id': vid})
        pause, dead = 'pause-fixed', 2147483647
        status = self.cont / 'retired-status.json'
        control = self.cont / 'retired-control.json'
        retirement = self.cont / 'retirement.json'
        live_auth = self.cont / 'live-revoked-auth.json'
        live_admission = self.cont / 'live-revoked-admission.json'
        p.audit.atomic(status, {'job_id': 'SNIPPY-LUNA-CONTINUE-20261001', 'phase': 'paused',
            'desired': 'paused', 'own_children_alive': False, 'runner_pid': None, 'asr_pid': None,
            'asr_launcher_pid': None, 'supervisor_pid': dead,
            'runner_status': {'active_batches': [], 'active_ids': []}})
        p.audit.atomic(control, {'desired': 'paused', 'processed_ids': [pause],
                                 'last_applied_order': ['x', 'y', pause]})
        p.audit.atomic(retirement, {'retired_job_id': 'SNIPPY-LUNA-CONTINUE-20261001',
            'superseded_by': self.job, 'supervisor_alive': False, 'process_locks_were_free': True})
        p.audit.atomic(live_auth, {'scope': 'revoked', 'superseded_by': self.job})
        p.audit.atomic(live_admission, {'approved': False, 'superseded_by': self.job})
        self.auth_path = self.cont / 'authorization.json'
        auth = {'schema_version': 'snippy-fixed-subset-authorization-v1', 'job_id': self.job,
            'scope': p.FIXED_SUBSET_SCOPE, 'codex_on_shadow': True,
            'manifest_sha256': p.luna.sha(self.root / 'input/manifest.json'),
            'original_manifest_sha256': p.luna.sha(self.root / 'input/manifest.json'),
            'culled_ids_sha256': p.luna.sha(self.root / 'input/culled-ids.json'),
            'selected_ids_file': self.ids_path.name, 'selected_ids_sha256': p.luna.sha(self.ids_path),
            'candidate_count': len(self.ids), 'recoverable_failed_ids': [], 'recovery_proofs': {},
            'max_batch_members': 5, 'batch_workers': 2, 'render_slots': 2, 'asr_slots': 1,
            'publication_writers': 1, 'min_release_confidence': .95, 'max_passes': p.luna.MAX_PASSES,
            'broad_owner_handoff': {'job_id': 'SNIPPY-LUNA-CONTINUE-20261001',
                'status_path': str(status.resolve()), 'status_sha256': p.luna.sha(status),
                'control_state_path': str(control.resolve()), 'control_state_sha256': p.luna.sha(control),
                'required_pause_control_id': pause, 'supervisor_pid': dead,
                'retirement_receipt_path': str(retirement.resolve()),
                'retirement_receipt_sha256': p.luna.sha(retirement),
                'live_authorization_path': str(live_auth.resolve()),
                'live_authorization_sha256': p.luna.sha(live_auth),
                'live_admission_path': str(live_admission.resolve()),
                'live_admission_sha256': p.luna.sha(live_admission)}}
        auth['authorization_sha256'] = p.audit.digest(auth)
        p.audit.atomic(self.auth_path, auth)
        # One selected terminal record; three selected pending members share an
        # immutable paid batch with two outsiders. Five selected IDs are fresh.
        receipt = self.root / 'publications' / f'{self.ids[0]}.json'
        p.audit.atomic(receipt, {'passed': True, 'video_id': self.ids[0]})
        self.record(self.ids[0], 'published', publication_receipt=str(receipt))
        for vid in self.ids[1:4]:
            self.record(vid, 'paused')
        self.outsider = self.candidates[500]['candidate_id']
        self.record(self.outsider, 'published')
        mixed = self.ids[1:4] + [self.candidates[400]['candidate_id'], self.candidates[401]['candidate_id']]
        p.audit.atomic(self.root / 'batches/old-mixed/batch-plan.json', {
            'slot_candidate_ids': mixed, 'candidate_ids': mixed, 'run_hash': 'immutable-paid-call'})
        p.audit.atomic(self.root / 'batches/old-mixed/finalizer/response.json', {
            'id': 'resp_historical_mixed', 'model': 'gpt-6-luna', 'status': 'completed'})
        p.audit.atomic(self.root / 'batches/old-mixed/finalizer/request.json', {
            'api_key': 'raw-secret-must-never-enter-the-receipt'})
        self.inputs = patch('production.audit.inputs', return_value=[])
        self.inputs.start()
        self.addCleanup(self.inputs.stop)

    def record(self, vid, status, **values):
        p.audit.atomic(self.root / 'records' / f'{vid}.json', {'candidate_id': vid, 'status': status, **values})

    def runner(self):
        return p.Runner(self.root, 'whisper', batch_workers=2, continuation_id=self.job,
                        continuation_authorization=self.auth_path, continuation_plan_only=True)

    def rewrite_auth(self, **values):
        auth = p.luna.read(self.auth_path)
        auth.update(values)
        auth.pop('authorization_sha256', None)
        auth['authorization_sha256'] = p.audit.digest(auth)
        p.audit.atomic(self.auth_path, auth)

    def test_exact_plan_preserves_order_and_holds_only_mixed_selected_members(self):
        runner = self.runner()
        plan = runner.continuation_plan()
        self.assertEqual(plan['authorized_candidate_ids'], self.ids)
        self.assertEqual(plan['candidate_ids'], self.ids[1:])
        self.assertEqual([row['candidate_id'] for row in plan['preflight_holds']], self.ids[1:4])
        self.assertEqual([row['batch_name'] for row in plan['mixed_batch_inventories']], ['old-mixed'])
        self.assertFalse((self.cont / 'preflight-hold-dispositions.json').exists())
        self.assertEqual([vid for slot in plan['slots'] for vid in slot['execution_candidate_ids']], self.ids[4:])
        self.assertEqual([len(slot['candidate_ids']) for slot in plan['slots']], [5] * 67 + [1])
        before = (self.root / 'records' / f'{self.outsider}.json').read_bytes()
        held_before = {vid: (self.root / 'records' / f'{vid}.json').read_bytes() for vid in self.ids[1:4]}
        runner.apply_preflight_holds()
        receipt = p.luna.read(self.cont / 'preflight-hold-dispositions.json')
        self.assertEqual([row['candidate_id'] for row in receipt['holds']], self.ids[1:4])
        self.assertEqual([row['effective_status'] for row in receipt['holds']], ['awaiting_astra'] * 3)
        self.assertEqual([row['batch_name'] for row in receipt['mixed_batch_inventories']], ['old-mixed'])
        inventory_paths = [row['path'] for row in receipt['mixed_batch_inventories'][0]['files']]
        self.assertEqual(inventory_paths, [
            'batch-plan.json', 'finalizer/request.json', 'finalizer/response.json'])
        self.assertNotIn('raw-secret-must-never-enter-the-receipt',
                         (self.cont / 'preflight-hold-dispositions.json').read_text(encoding='utf-8'))
        self.assertEqual({vid: (self.root / 'records' / f'{vid}.json').read_bytes() for vid in self.ids[1:4]},
                         held_before)
        self.assertEqual((self.root / 'records' / f'{self.outsider}.json').read_bytes(), before)

    def test_preflight_hold_record_rewrite_and_receipt_tamper_fail_closed(self):
        runner = self.runner()
        runner.continuation_plan()
        runner.apply_preflight_holds()
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'preflight-held'):
            runner.save(self.ids[1], 'awaiting_astra')
        receipt_path = self.cont / 'preflight-hold-dispositions.json'
        receipt_path.write_bytes(receipt_path.read_bytes() + b'\n')
        # Raw JSON whitespace does not change the self-hash, so this path also
        # proves all semantic evidence is revalidated rather than trusted from memory.
        self.assertFalse(runner.candidate_pending(self.ids[1]))
        row = p.luna.read(receipt_path)
        row['holds'][0]['record_sha256'] = '0' * 64
        p.audit.atomic(receipt_path, row)
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'identity|evidence'):
            runner.candidate_pending(self.ids[1])

    def test_mixed_paid_batch_mutation_and_addition_fail_closed(self):
        runner = self.runner()
        plan = runner.continuation_plan()
        self.assertEqual(plan['mixed_batch_inventories'][0]['file_count'], 3)
        self.assertFalse((self.cont / 'preflight-hold-dispositions.json').exists())
        response = self.root / 'batches/old-mixed/finalizer/response.json'
        original = response.read_bytes()
        response.write_bytes(original + b'\n')
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'mixed batch inventory changed'):
            runner.apply_preflight_holds()

        response.write_bytes(original)
        p.audit.atomic(self.root / 'batches/old-mixed/finalizer/replay-call-state.json', {
            'status': 'submitted', 'attempt': 2})
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'mixed batch inventory changed'):
            runner.scope_guard(full=True, verify_mixed_inventory=True)

    def test_hot_paths_do_not_rehash_mixed_batch_inventory(self):
        runner = self.runner()
        runner.continuation_plan()
        runner.apply_preflight_holds()
        with patch('production.immutable_batch_inventory',
                   side_effect=AssertionError('hot path rehashed historical batch')):
            self.assertFalse(runner.candidate_pending(self.ids[1]))
            runner.scope_guard(self.ids[4], full=True)

    def test_known_hash_migration_preserves_existing_semantics_and_order(self):
        runner = self.runner()
        runner.continuation_plan()
        plan_path = self.cont / 'continuation-plan.json'
        legacy = p.luna.read(plan_path)
        legacy.pop('mixed_batch_inventories')
        legacy.pop('plan_sha256')
        legacy['plan_sha256'] = p.audit.digest(legacy)
        p.audit.atomic(plan_path, legacy)
        old_raw, old_self = p.luna.sha(plan_path), legacy['plan_sha256']
        old_pairs = [(key, value) for key, value in legacy.items() if key != 'plan_sha256']
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'raw hash'):
            migration.migrate(self.root, self.cont, '0' * 64, old_self)
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'self-hash'):
            migration.migrate(self.root, self.cont, old_raw, '0' * 64)
        for lock_name in ('production-owner.lock', 'runner.lock'):
            with self.subTest(lock=lock_name), p.runner_lock(self.root / lock_name):
                with self.assertRaises(OSError):
                    migration.migrate(self.root, self.cont, old_raw, old_self)
        authority = {'prior_plan_file_sha256': old_raw, 'prior_plan_sha256': old_self}
        wrong_new = {**authority, 'migrated_plan_file_sha256': 'e' * 64,
                     'migrated_plan_sha256': 'd' * 64}
        with patch.dict(p.FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES,
                        {self.job: wrong_new}, clear=False), self.assertRaisesRegex(
                            p.ContinuationIntegrityError, 'known new authority'):
            migration.migrate(
                self.root, self.cont, old_raw, old_self, '2026-10-01T12:00:00+00:00')
        self.assertEqual(p.luna.sha(plan_path), old_raw)
        with patch.dict(p.FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES,
                        {self.job: authority}, clear=False):
            result = migration.migrate(
                self.root, self.cont, old_raw, old_self, '2026-10-01T12:00:00+00:00')
        migrated = p.luna.read(plan_path)
        authority.update(migrated_plan_file_sha256=result['plan_file_sha256'],
                         migrated_plan_sha256=result['plan_sha256'])
        self.assertEqual([(key, migrated[key]) for key, _ in old_pairs], old_pairs)
        self.assertEqual(migrated['mixed_batch_inventory_migration'], {
            'prior_plan_file_sha256': old_raw, 'prior_plan_sha256': old_self,
            'frozen_at': '2026-10-01T12:00:00+00:00'})
        self.assertEqual(result['mixed_batch_count'], 1)
        self.assertEqual(result['mixed_batch_file_count'], 3)
        forged = p.luna.read(plan_path)
        forged['mixed_batch_inventory_migration']['prior_plan_sha256'] = 'f' * 64
        forged.pop('plan_sha256')
        forged['plan_sha256'] = p.audit.digest(forged)
        p.audit.atomic(plan_path, forged)
        with patch.dict(p.FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES,
                        {self.job: authority}, clear=False), self.assertRaisesRegex(
                            p.ContinuationIntegrityError, 'raw authority|migration provenance'):
            self.runner().continuation_plan()
        missing = dict(migrated)
        missing.pop('mixed_batch_inventory_migration')
        missing.pop('plan_sha256')
        missing['plan_sha256'] = p.audit.digest(missing)
        p.audit.atomic(plan_path, missing)
        with patch.dict(p.FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES,
                        {self.job: authority}, clear=False), self.assertRaisesRegex(
                            p.ContinuationIntegrityError,
                            'raw authority|migration provenance is missing'):
            self.runner().continuation_plan()
        response = self.root / 'batches/old-mixed/finalizer/response.json'
        response.write_bytes(response.read_bytes() + b'\n')
        rebased = dict(migrated)
        rebased['mixed_batch_inventories'] = [
            p.immutable_batch_inventory(self.root, 'old-mixed')]
        rebased.pop('plan_sha256')
        rebased['plan_sha256'] = p.audit.digest(rebased)
        p.audit.atomic(plan_path, rebased)
        with patch.dict(p.FIXED_SUBSET_PLAN_MIGRATION_AUTHORITIES,
                        {self.job: authority}, clear=False), self.assertRaisesRegex(
                            p.ContinuationIntegrityError, 'raw authority|migration provenance'):
            self.runner().continuation_plan()

    def test_outsider_write_and_raw_plan_tamper_fail_closed(self):
        runner = self.runner()
        runner.continuation_plan()
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'outside the fixed subset'):
            runner.save(self.candidates[400]['candidate_id'], 'preparing')
        plan_path = self.cont / 'continuation-plan.json'
        plan_path.write_bytes(plan_path.read_bytes() + b'\n')
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'plan changed'):
            runner.save(self.ids[4], 'preparing')

    def test_existing_plan_must_exactly_cover_every_manifest_outsider(self):
        runner = self.runner()
        runner.continuation_plan()
        plan_path = self.cont / 'continuation-plan.json'
        plan = p.luna.read(plan_path)
        omitted = plan['protected_absent_ids'].pop()
        plan.pop('plan_sha256')
        plan['plan_sha256'] = p.audit.digest(plan)
        p.audit.atomic(plan_path, plan)

        with self.assertRaisesRegex(ValueError, 'protection cover is not exact and disjoint'):
            self.runner().continuation_plan()
        self.assertIn(omitted, {row['candidate_id'] for row in self.candidates} - set(self.ids))

    def test_scope_guard_rejects_live_record_filename_outside_manifest(self):
        runner = self.runner()
        runner.continuation_plan()
        rogue = 'rogue000000'
        self.record(rogue, 'published')

        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'escape the frozen manifest'):
            runner.scope_guard(self.ids[4])

    def test_scope_guard_rejects_unprotected_manifest_outsider_record(self):
        runner = self.runner()
        runner.continuation_plan()
        appeared = self.candidates[600]['candidate_id']
        self.record(appeared, 'published')

        with self.assertRaisesRegex(
                p.ContinuationIntegrityError, 'neither selected nor protected existing outsiders'):
            runner.scope_guard(self.ids[4])

    def test_orphan_paid_artifacts_fail_before_plan_creation(self):
        p.audit.atomic(self.root / 'batches/orphan-paid/call-state.json', {
            'request_key': 'ambiguous', 'status': 'submitted'})
        with self.assertRaisesRegex(ValueError, 'Paid artifacts lack frozen batch membership'):
            self.runner().continuation_plan()

    def test_plan_tamper_fails_before_render_or_media_access(self):
        runner = self.runner()
        runner.continuation_plan()
        plan_path = self.cont / 'continuation-plan.json'
        plan = p.luna.read(plan_path)
        p.audit.atomic(plan_path, {**plan, 'tampered': True})
        item = {**self.candidates[4], 'packet_sha256': 'not-used'}
        with patch('production.media.render') as render, self.assertRaises(p.ContinuationIntegrityError):
            runner.prepare(item)
        render.assert_not_called()

    def test_duplicate_culled_wrong_count_and_original_manifest_fail(self):
        original = self.ids_path.read_bytes()
        short = ('\n'.join(self.ids[:-1]) + '\n').encode('ascii')
        self.ids_path.write_bytes(short)
        self.rewrite_auth(selected_ids_sha256=p.luna.sha(self.ids_path), candidate_count=339)
        with self.assertRaisesRegex(ValueError, 'count'):
            self.runner()
        self.ids_path.write_bytes((self.ids[0] + '\n' + self.ids[0] + '\n').encode('ascii'))
        self.rewrite_auth(selected_ids_sha256=p.luna.sha(self.ids_path), candidate_count=2)
        with self.assertRaisesRegex(ValueError, 'invalid or duplicated'):
            self.runner()
        self.ids_path.write_bytes(original)
        self.rewrite_auth(selected_ids_sha256=p.luna.sha(self.ids_path), candidate_count=len(self.ids))
        culls = p.luna.read(self.root / 'input/culled-ids.json') + [{'video_id': self.ids[2]}]
        p.audit.atomic(self.root / 'input/culled-ids.json', culls)
        self.rewrite_auth(culled_ids_sha256=p.luna.sha(self.root / 'input/culled-ids.json'))
        with self.assertRaisesRegex(ValueError, 'membership'):
            self.runner()
        culls.pop()
        p.audit.atomic(self.root / 'input/culled-ids.json', culls)
        self.rewrite_auth(culled_ids_sha256=p.luna.sha(self.root / 'input/culled-ids.json'),
                          original_manifest_sha256='0' * 64)
        with self.assertRaisesRegex(ValueError, 'policy'):
            self.runner()

    def test_fixed_run_completes_only_authorized_ids_and_preserves_outsider(self):
        outsider_before = (self.root / 'records' / f'{self.outsider}.json').read_bytes()
        runner = self.runner()
        runner.continuation_plan()
        runner.continuation_plan_only = False
        query = Mock(job_id='offline', total_bytes_billed=0, cache_hit=True)
        query.result.return_value = []
        client = Mock(); client.query.return_value = query
        def dispose(_batch, slot):
            for item in slot:
                if runner.candidate_pending(item['candidate_id']):
                    runner.save(item['candidate_id'], 'awaiting_astra', reason='offline fixture hold',
                                packet_path=str(self.root / 'input/candidates' / f"{item['candidate_id']}.json"))
            return True
        with patch('production.audit.bq_client', return_value=client), \
                patch.object(runner, 'process_batch', side_effect=dispose), \
                patch.object(runner, 'validate_live_fixed_owner'):
            runner.run()
        status = p.luna.read(self.cont / 'continuation-status.json')
        self.assertEqual(status['phase'], 'continuation_completed')
        self.assertEqual(status['authorized_candidate_count'], len(self.ids))
        self.assertEqual(status['remaining'], 0)
        self.assertEqual((self.root / 'records' / f'{self.outsider}.json').read_bytes(), outsider_before)
        self.assertEqual(p.luna.read(self.cont / 'subset-verification.json')['requested'], len(self.ids))

    def test_plan_only_runner_cannot_execute_and_execution_requires_live_owner(self):
        runner = self.runner()
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'Plan-only'):
            runner.run()
        runner.continuation_plan_only = True
        runner.continuation_plan()
        runner.continuation_plan_only = False
        with self.assertRaisesRegex(p.ContinuationIntegrityError, 'owner record is missing'):
            runner.continuation_plan()


if __name__ == '__main__':
    unittest.main()
