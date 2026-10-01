"""Offline regressions for authorized continuation of an interrupted paid queue."""
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import production as p


class ContinuationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'run'
        self.auth = Path(self.temp.name) / 'continuation' / 'authorization.json'
        self.job = 'SNIPPY-LUNA-CONTINUE-20261001'
        self.candidates = [{'candidate_id': f'v{i:010}', 'lane': 'eligible' if i < 1116 else 'review'} for i in range(1644)]
        p.audit.atomic(self.root / 'input/manifest.json', {'candidates': self.candidates})
        p.audit.atomic(self.root / 'input/already-published.json', {})
        p.audit.atomic(self.root / 'input/culled-ids.json', [])
        p.audit.atomic(self.root / 'experiment-plan.json', {'experiment_id': 'old-closed'})
        p.audit.atomic(self.root / 'experiment-status.json', {'phase': 'paused', 'drained_at': 'before'})
        p.audit.atomic(self.auth, {'job_id': self.job, 'scope': 'all_remaining_frozen_manifest',
                                 'codex_on_shadow': True, 'manifest_sha256': p.luna.sha(self.root / 'input/manifest.json')})
        self.inputs = patch('production.audit.inputs', return_value=[])
        self.inputs.start()
        self.addCleanup(self.inputs.stop)

    def record(self, index, status):
        vid = self.candidates[index]['candidate_id']
        p.audit.atomic(self.root / 'records' / f'{vid}.json', {'candidate_id': vid, 'status': status})
        return vid

    def runner(self, **kwargs):
        return p.Runner(self.root, 'whisper', batch_workers=2, continuation_id=self.job,
                        continuation_authorization=self.auth, **kwargs)

    def paid_batch(self, indexes):
        ids = [self.candidates[index]['candidate_id'] for index in indexes]
        batch = self.root / 'batches' / 'old-paid-0001'
        p.audit.atomic(batch / 'batch-plan.json', {'slot_candidate_ids': ids, 'candidate_ids': ids,
                       'directories': ['original-' + vid for vid in ids], 'run_hash': 'exact-original-run-hash'})
        return batch, ids

    def authorize_recovery(self, indexes):
        auth = p.luna.read(self.auth)
        auth.update(recoverable_failed_ids=[], recovery_proofs={})
        for index in indexes:
            vid = self.record(index, 'failed')
            backup = self.auth.parent / 'backups' / f'{vid}.json'
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes((self.root / 'records' / f'{vid}.json').read_bytes())
            media = self.auth.parent / f'{vid}.mp4'
            media.write_bytes(b'fixture-failure-evidence')
            auth['recoverable_failed_ids'].append(vid)
            auth['recovery_proofs'][vid] = {'record_sha256': p.luna.sha(backup), 'backup_path': str(backup),
                'classification': 'windows_local_downstream_disconnect_misclassified_as_transfer_failure',
                'no_prior_paid_membership': True, 'maximum_recovery_attempts': 1,
                'failure_evidence': {'full_decode_exit': 0, 'ffprobe_exit': 0,
                                     'artifact': {'path': str(media), 'sha256': p.luna.sha(media)}}}
        p.audit.atomic(self.auth, auth)

    def test_recovery_is_separate_from_old_slots_and_cannot_retry_a_new_failure(self):
        self.authorize_recovery([0, 1])
        self.record(2, 'paused')
        batch, ids = self.paid_batch([0, 1, 2])
        old = p.luna.read(batch / 'batch-plan.json')
        old['candidate_ids'] = ids[2:]
        p.audit.atomic(batch / 'batch-plan.json', old)
        before = (batch / 'batch-plan.json').read_bytes()
        runner = self.runner()
        plan = runner.continuation_plan()
        self.assertEqual(plan['slots'][0]['candidate_ids'], ids)
        self.assertEqual(plan['slots'][0]['execution_candidate_ids'], ids[2:])
        recovery = plan['slots'][1]
        self.assertEqual(recovery['origin'], 'authorized_local_failure_recovery')
        self.assertEqual(recovery['execution_candidate_ids'], ids[:2])
        self.assertTrue(runner.candidate_pending(ids[0]))
        runner.save(ids[0], 'failed', error='new concrete failed recovery')
        self.assertFalse(runner.candidate_pending(ids[0]))
        self.assertFalse(self.runner().candidate_pending(ids[0]))
        self.assertTrue(self.runner().candidate_pending(ids[1]))
        self.assertEqual(self.runner().continuation_plan(), plan)
        self.assertEqual((batch / 'batch-plan.json').read_bytes(), before)

    def test_recovery_with_prior_paid_membership_or_changed_backup_is_forbidden(self):
        self.authorize_recovery([0])
        batch, _ = self.paid_batch([0, 1])
        with self.assertRaisesRegex(ValueError, 'already belongs to a paid request'):
            self.runner().continuation_plan()
        (batch / 'batch-plan.json').unlink()
        auth = p.luna.read(self.auth)
        backup = Path(next(iter(auth['recovery_proofs'].values()))['backup_path'])
        backup.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'immutable diagnosed local failure backup'):
            self.runner()

    def test_recovery_paused_during_old_batch_resume_does_not_join_its_paid_membership(self):
        self.authorize_recovery([0])
        self.record(1, 'paused')
        batch, ids = self.paid_batch([0, 1])
        old = p.luna.read(batch / 'batch-plan.json')
        old['candidate_ids'] = ids[1:]
        p.audit.atomic(batch / 'batch-plan.json', old)
        runner = self.runner()
        runner.continuation_plan()
        runner.save(ids[0], 'paused', previous_status='preparing')
        result = {'decisions': [{'candidate_id': ids[1], 'status': 'hold', 'complete': False,
                                'astra_escalation_path': 'held.json'}]}
        with patch('production.bound_batch_plan', return_value={'candidate_ids': ids[1:]}), \
                patch('production.planned_pipeline', return_value=result), patch.object(runner, 'prepare') as prepare:
            self.assertTrue(runner.process_batch(batch, self.candidates[:2]))
            prepare.assert_not_called()
        self.assertEqual(runner.records[ids[0]]['status'], 'paused')
        self.assertEqual(runner.records[ids[1]]['status'], 'awaiting_astra')

    def test_systemic_batch_failures_stop_continuation_after_three_and_drain(self):
        runner = self.runner()
        slots = [(self.root / 'batches' / str(i), []) for i in range(8)]
        with patch.object(runner, 'batch_slots', return_value=iter(slots)), \
                patch.object(runner, 'process_batch', return_value=False) as process:
            with self.assertRaisesRegex(RuntimeError, 'Three consecutive batch failures'):
                runner.run_batches()
            self.assertGreaterEqual(process.call_count, 3)
            self.assertLessEqual(process.call_count, 4)
        with patch.object(runner, 'batch_slots', return_value=iter(slots)), \
                patch.object(runner, 'process_batch', side_effect=p.ContinuationIntegrityError('frozen packet changed')) as process:
            with self.assertRaisesRegex(RuntimeError, 'Immutable continuation integrity failure'):
                runner.run_batches()
            self.assertLessEqual(process.call_count, 2)

    def test_proven_source_skips_continue_but_asr_provider_auth_and_publication_failures_count(self):
        for stage, cause, stopped in [('preparation', 'source_missing_404', False),
                                      ('preparation', 'source_missing_410', False),
                                      ('preparation', 'source_eof_duration_mismatch', False),
                                      ('preparation', None, True), ('luna', None, True),
                                      ('publication', 'source_missing_404', True)]:
            with self.subTest(stage=stage, cause=cause):
                runner = self.runner()
                slots = [(self.root / 'batches' / str(i), [self.candidates[i]]) for i in range(8)]
                def process(batch, slot):
                    runner.records[slot[0]['candidate_id']] = {'candidate_id': slot[0]['candidate_id'], 'status': 'failed', 'stage': stage,
                                                              'isolated_source_failure': cause}
                    return False
                with patch.object(runner, 'batch_slots', return_value=iter(slots)), patch.object(runner, 'process_batch', side_effect=process) as work:
                    if stopped:
                        with self.assertRaisesRegex(RuntimeError, 'Three consecutive batch failures'):
                            runner.run_batches()
                        self.assertLessEqual(work.call_count, 4)
                    else:
                        self.assertTrue(runner.run_batches())
                        self.assertEqual(work.call_count, 8)

    def test_missing_source_classifier_never_exempts_auth_or_unknown_errors(self):
        runner = self.runner()
        for code in (404, 410, 401, 403, 429, 503):
            response = p.requests.Response()
            response.status_code = code
            error = p.requests.HTTPError('concrete HTTP response', response=response)
            self.assertEqual(runner.isolated_source_failure('vid', error),
                             'source_missing_' + str(code) if code in (404, 410) else None)
        self.assertIsNone(runner.isolated_source_failure('vid', RuntimeError('404 text is not HTTP evidence')))

    def test_eof_classifier_requires_duration_only_failure_and_matching_short_source(self):
        runner = self.runner()
        vid = self.candidates[0]['candidate_id']
        obj = {'bucket': 'b', 'name': 'n', 'generation': 'g', 'size': '50'}
        p.audit.atomic(runner.input / 'candidates' / f'{vid}.json', {'gcs_object': obj})
        recipe = {'edits': [{'start_seconds': 10, 'end_seconds': 100}]}
        p.audit.atomic(self.root / 'recipes' / f'{vid}.json', recipe)
        directory = self.root / 'rendered' / (vid + '-test')
        p.audit.atomic(directory / 'recipe.json', recipe)
        p.audit.atomic(directory / 'source.json', obj)
        p.audit.atomic(directory / 'source-ffprobe.json', {'format': {'duration': 98}})
        p.audit.atomic(directory / 'transfer.json', {'errors': []})
        qa = {'video': True, 'audio': True, 'duration': False, 'native_dimensions': True, 'native_fps': True, 'full_decode': True}
        p.audit.atomic(directory / 'qa.json', {'checks': qa})
        self.assertEqual(runner.isolated_source_failure(vid, ValueError('Output QA failed')), 'source_eof_duration_mismatch')
        p.audit.atomic(directory / 'qa.json', {'checks': {**qa, 'native_fps': False}})
        self.assertIsNone(runner.isolated_source_failure(vid, ValueError('Output QA failed')))
        p.audit.atomic(directory / 'qa.json', {'checks': qa})
        p.audit.atomic(directory / 'source-ffprobe.json', {'format': {'duration': 101}})
        self.assertIsNone(runner.isolated_source_failure(vid, ValueError('Output QA failed')))

    def test_full_scope_retains_old_paid_membership_and_protects_all_prior_dispositions(self):
        for index in range(49):
            self.record(index, ('already_published', 'published', 'awaiting_astra', 'failed')[index % 4])
        for index in range(49, 80):
            self.record(index, 'paused')
        batch, old_ids = self.paid_batch([48, 49, 50, 51, 52])
        before = {path: path.read_bytes() for path in (self.root / 'records').glob('*.json')}
        plan = self.runner().continuation_plan()
        self.assertEqual(plan['target_candidate_count'], 1595)
        self.assertEqual(len(plan['protected_record_sha256']), 49)
        first = plan['slots'][0]
        self.assertEqual(first['candidate_ids'], old_ids)
        self.assertEqual(first['batch_name'], batch.name)
        self.assertEqual(first['origin'], 'existing_paid_batch')
        self.assertTrue(all(len(slot['candidate_ids']) <= 5 for slot in plan['slots']))
        self.assertEqual({slot['items'][0]['lane'] for slot in plan['slots']}, {'eligible', 'review'})
        self.assertEqual(before, {path: path.read_bytes() for path in before})
        with patch('production.luna.pipeline') as paid, patch('production.media.render') as render:
            self.assertEqual(self.runner().continuation_plan(), plan)
            paid.assert_not_called()
            render.assert_not_called()

    def test_resume_never_reselects_or_shrinks_original_paid_slot(self):
        for index in range(5):
            self.record(index, 'paused')
        batch, ids = self.paid_batch(range(5))
        runner = self.runner()
        plan = runner.continuation_plan()
        self.record(0, 'published')
        resumed = self.runner()
        self.assertEqual(resumed.continuation_plan(), plan)
        first_batch, first_items = next(resumed.batch_slots())
        self.assertEqual(first_batch, batch)
        self.assertEqual([row['candidate_id'] for row in first_items], ids)

    def test_changed_protected_record_or_old_paid_plan_fails_before_execution(self):
        protected = self.record(0, 'awaiting_astra')
        batch, _ = self.paid_batch([0, 1])
        runner = self.runner()
        runner.continuation_plan()
        with self.assertRaisesRegex(ValueError, 'cannot rewrite'):
            runner.save(protected, 'preparing')
        self.record(0, 'published')
        with self.assertRaisesRegex(ValueError, 'Protected prior disposition changed'):
            self.runner().continuation_plan()
        self.record(0, 'awaiting_astra')
        p.audit.atomic(batch / 'batch-plan.json', {'changed': True})
        with self.assertRaisesRegex(ValueError, 'Prior checkpoint or paid batch plan changed'):
            self.runner().continuation_plan()

    def test_changed_authorization_or_input_manifest_fails_closed(self):
        runner = self.runner()
        runner.continuation_plan()
        auth = p.luna.read(self.auth)
        p.audit.atomic(self.auth, {**auth, 'audit_extra': 'changed after plan'})
        with self.assertRaisesRegex(ValueError, 'authorization, or manifest changed'):
            self.runner().continuation_plan()
        p.audit.atomic(self.auth, auth)
        p.audit.atomic(self.root / 'input/manifest.json', {'candidates': []})
        with self.assertRaisesRegex(ValueError, 'authorization does not match'):
            self.runner()

    def test_unknown_paid_artifacts_or_duplicate_pending_membership_rejected(self):
        batch, _ = self.paid_batch([1, 2])
        p.audit.atomic(self.root / 'batches/other/batch-plan.json', p.luna.read(batch / 'batch-plan.json'))
        with self.assertRaisesRegex(ValueError, 'duplicated'):
            self.runner().continuation_plan()
        (self.root / 'batches/other/batch-plan.json').unlink()
        p.audit.atomic(self.root / 'batches/other/call-state.json', {'charge_unknown': True})
        with self.assertRaisesRegex(ValueError, 'lack frozen batch membership'):
            self.runner().continuation_plan()

    def test_omitted_pending_member_is_not_moved_out_of_paid_scope(self):
        batch, ids = self.paid_batch([1, 2])
        plan = p.luna.read(batch / 'batch-plan.json')
        plan['candidate_ids'] = ids[:1]
        p.audit.atomic(batch / 'batch-plan.json', plan)
        with self.assertRaisesRegex(ValueError, 'omitted'):
            self.runner().continuation_plan()

    def test_continuation_rejects_old_scope_limits_and_incomplete_authorization(self):
        with self.assertRaisesRegex(ValueError, 'unlimited frozen scope'):
            self.runner(limit=10)
        with self.assertRaisesRegex(ValueError, 'both its job ID'):
            p.Runner(self.root, 'whisper', continuation_id=self.job)
        auth = p.luna.read(self.auth)
        p.audit.atomic(self.auth, {**auth, 'codex_on_shadow': False})
        with self.assertRaisesRegex(ValueError, 'executor'):
            self.runner()

    def test_paid_resume_skips_preparation_and_terminal_member_publication(self):
        self.record(0, 'published')
        self.record(1, 'paused')
        batch, ids = self.paid_batch([0, 1])
        runner = self.runner()
        runner.continuation_plan()
        result = {'decisions': [{'candidate_id': vid, 'status': 'hold', 'complete': False,
                                'astra_escalation_path': 'held.json'} for vid in ids]}
        with patch('production.bound_batch_plan', return_value={'candidate_ids': ids}) as bind, \
                patch('production.planned_pipeline', return_value=result), patch.object(runner, 'prepare') as prepare, \
                patch('production.publish_astra.publish') as publish:
            self.assertTrue(runner.process_batch(batch, [self.candidates[0], self.candidates[1]]))
            self.assertEqual(bind.call_args.args[1], ids)
            prepare.assert_not_called()
            publish.assert_not_called()
        self.assertEqual(runner.records[ids[0]]['status'], 'published')
        self.assertEqual(runner.records[ids[1]]['status'], 'awaiting_astra')

    def test_asr_shutdown_race_pauses_instead_of_permanently_failing(self):
        runner = self.runner()
        item = {'candidate_id': self.candidates[0]['candidate_id'], 'packet_sha256': p.audit.digest({'source': True})}
        packet = {'source': True}
        p.audit.atomic(runner.input / 'candidates' / f"{item['candidate_id']}.json", packet)
        runner.sources[item['candidate_id']] = {}
        directory = self.root / 'rendered' / item['candidate_id']
        def stopped_asr(*args):
            p.audit.atomic(self.root / 'STOP.json', {'reason': 'operator'})
            raise RuntimeError('Resident ASR server closed during STOP')
        with patch('production.seed', return_value={}), patch('production.media.validate'), \
                patch('production.media.render', return_value={'clip_path': str(directory / 'clip.mp4'), 'transfer': {}, 'output_bytes': 1}), \
                patch('production.luna.ensure_asr', side_effect=stopped_asr):
            self.assertIsNone(runner.prepare(item))
        self.assertEqual(runner.records[item['candidate_id']]['status'], 'paused')
        self.assertEqual(runner.records[item['candidate_id']]['previous_status'], 'transcribing')

    def test_prepared_resume_reuses_verified_media_even_if_encoder_selection_changed(self):
        runner = self.runner()
        vid = self.candidates[0]['candidate_id']
        packet = {'source': True, 'gcs_object': {'generation': 'original'}}
        item = {'candidate_id': vid, 'packet_sha256': p.audit.digest(packet)}
        p.audit.atomic(runner.input / 'candidates' / f'{vid}.json', packet)
        runner.sources[vid] = {}
        directory = self.root / 'rendered' / vid
        p.audit.atomic(directory / 'recipe.json', {'original': 'seed'})
        p.audit.atomic(directory / 'result.json', {'clip_path': str(directory / 'clip.mp4'), 'transfer': {}, 'output_bytes': 1})
        (directory / 'contact.jpg').write_bytes(b'contact')
        runner.save(vid, 'paused', directory=str(directory), previous_status='transcribing')
        with patch('production.seed', return_value={'original': 'seed'}), patch('production.media.validate'), \
                patch('bounded_window_cache.open_window') as validate_cache, \
                patch('production.media.verify_current_source') as source, patch('production.media.render') as render, \
                patch('production.luna.ensure_asr') as asr:
            self.assertEqual(runner.prepare(item), directory)
            validate_cache.assert_called_once_with(directory.resolve(), runner.input)
            source.assert_called_once_with(packet['gcs_object'])
            render.assert_not_called()
            asr.assert_called_once_with(directory, 'whisper')
        self.assertEqual(runner.records[vid]['status'], 'prepared')

    def test_pause_is_bounded_to_two_groups_and_resumes_same_slots(self):
        runner = self.runner()
        plan = runner.continuation_plan()
        barrier = threading.Barrier(2)
        admitted = []
        def process(batch, slot):
            admitted.append(batch.name)
            for item in slot:
                runner.save(item['candidate_id'], 'paused')
            barrier.wait(timeout=5)
            p.audit.atomic(self.root / 'STOP.json', {})
            return True
        with patch.object(runner, 'process_batch', side_effect=process):
            with self.assertRaises(p.luna.OperationalPause):
                runner.run_batches()
        self.assertEqual(set(admitted), {slot['batch_name'] for slot in plan['slots'][:2]})
        (self.root / 'STOP.json').unlink()
        self.assertEqual(self.runner().continuation_plan(), plan)

    def test_run_finishes_all_remaining_dispositions_and_preserves_protected_bytes(self):
        for index in range(3, 1644):
            self.record(index, 'awaiting_astra')
        job = Mock(job_id='offline-query', total_bytes_billed=0, cache_hit=True)
        job.result.return_value = []
        client = Mock()
        client.query.return_value = job
        runner = self.runner()
        protected = (self.root / 'records' / f"{self.candidates[3]['candidate_id']}.json").read_bytes()
        def process(batch, slot):
            for item in slot:
                runner.save(item['candidate_id'], 'awaiting_astra')
            return True
        with patch('production.audit.bq_client', return_value=client), patch.object(runner, 'process_batch', side_effect=process):
            runner.run()
        status = p.luna.read(self.auth.parent / 'continuation-status.json')
        self.assertEqual(status['phase'], 'continuation_completed')
        self.assertEqual(status['covered'], 3)
        self.assertEqual(status['remaining'], 0)
        self.assertEqual(status['counts'], {'awaiting_astra': 3})
        self.assertEqual((self.root / 'records' / f"{self.candidates[3]['candidate_id']}.json").read_bytes(), protected)


if __name__ == '__main__':
    unittest.main()
