import json
from pathlib import Path
import tempfile
import unittest

import audit
import luna_batch_qa as luna
from production_report import sha
from tiny_validation_report import TinyReporter


class TinyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ids = [f'v{i:010d}' for i in range(5)]
        self.old = [f'o{i:010d}' for i in range(50)]
        self.baseline = 'b0000000000'
        candidates = [{'candidate_id': vid, 'lane': 'eligible' if i < 3 else 'review'} for i, vid in enumerate(self.ids)]
        self.write('input/manifest.json', {'candidates': candidates})
        basepath = self.write('records/' + self.baseline + '.json', {'candidate_id': self.baseline, 'status': 'paused'})
        self.slots = [{'batch_name': 'tiny-' + lane, 'lane': lane, 'candidate_ids': [r['candidate_id'] for r in candidates if r['lane'] == lane],
                       'items': [r for r in candidates if r['lane'] == lane]} for lane in ('eligible', 'review')]
        self.plan = {'stream_id': 'tiny', 'target_candidate_count': 5, 'maximum_candidates': 5,
            'candidate_ids': self.ids, 'slots': self.slots, 'manifest_sha256': sha(self.root / 'input/manifest.json'),
            'excluded_prior_candidate_ids': self.old + [self.baseline], 'baseline_record_sha256': {self.baseline: sha(basepath)},
            'created_at': '2026-09-30T20:00:00Z'}
        self.save_plan()
        self.write('experiment-plan.json', {'candidate_ids': self.old})
        self.write('stream-status.json', {'stream_id': 'tiny', 'phase': 'stream_completed',
            'started_at': '2026-09-30T20:00:00Z', 'finished_at': '2026-09-30T20:02:00Z'})
        logs = []
        for i, vid in enumerate(self.ids):
            directory = self.root / 'rendered' / (vid + '-final')
            directory.mkdir(parents=True)
            (directory / 'clip.mp4').write_bytes(('final media ' + vid).encode())
            media_hash = sha(directory / 'clip.mp4')
            recipe = {'candidate_id': vid}
            self.write(str(directory / 'recipe.json'), recipe)
            self.write(str(directory / 'result.json'), {'candidate_id': vid, 'output_sha256': media_hash})
            self.write(str(directory / 'qa.json'), {'checks': {'full_decode': True, 'audio': True}})
            asr = {'words': [{'text': 'Hello', 'start': 0, 'end': 1}], 'provider': {
                'input_sha256': media_hash, 'model': 'small.en', 'device': 'cuda', 'compute_type': 'float32',
                'requested_fp16': False, 'threads': 8, 'beam_size': 5, 'vad_filter': False,
                'condition_on_previous_text': False, 'persistent_server': {'session_id': 'resident-test',
                    'request_number': i + 1, 'independent_transcription_of_requested_media': True}}}
            asrpath = self.write(str(directory / 'asr/clip.json'), asr)
            self.write(str(directory / 'asr/evidence.json'), {'media_sha256': media_hash, 'asr_sha256': sha(asrpath)})
            record = {'candidate_id': vid, 'status': 'published' if i == 0 else 'awaiting_astra',
                      'directory': str(directory), 'updated_at': '2026-09-30T20:02:00Z'}
            if i == 0:
                self.write(str(directory / 'final-qa.json'), {'passed': True, 'media_sha256': media_hash,
                    'recipe_hash': audit.digest(recipe), 'checks': {'picture_verified': True},
                    'release_gate': {'policy_version': luna.RELEASE_POLICY_VERSION, 'passed': True,
                        'min_release_confidence': .95, 'release_confidence': .99, 'escalation_reasons': []}})
                receipt = self.write('publications/' + vid + '.json', {'passed': True, 'video_id': vid,
                    'media_sha256': media_hash, 'recipe_hash': audit.digest(recipe), 'snippet_id': 'snippet-' + vid,
                    'gcs_generation': '123', 'uploaded_bytes': (directory / 'clip.mp4').stat().st_size})
                record.update(final_directory=str(directory), publication_receipt=str(receipt))
            self.write('records/' + vid + '.json', record)
            start, end = ('20:00:00', '20:00:30') if i < 3 else ('20:00:20', '20:01:10')
            logs += [f'2026-09-30T{start}Z {vid} preparing', f'2026-09-30T{end}Z {vid} prepared']
        (self.root / 'tiny-stdout.log').write_text('\n'.join(logs))
        for slot in self.slots:
            self.request(slot, 'finalizer')
            self.request(slot, 'verifier')
            self.write('batches/' + slot['batch_name'] + '/pipelines/p/ledger.json', {
                'rounds': [{'pass': 1, 'active_candidates': slot['candidate_ids']}]})

    def write(self, name, data):
        path = self.root / name
        audit.atomic(path, data)
        return path

    def save_plan(self):
        self.plan.pop('plan_sha256', None)
        self.plan['plan_sha256'] = audit.digest(self.plan)
        self.write('stream-plan.json', self.plan)

    def request(self, slot, role, status='response_saved'):
        body = {'model': 'gpt-6-luna', 'input': slot['batch_name'] + role + status}
        base = self.root / 'batches' / slot['batch_name'] / audit.digest(body)
        self.write(str(base / 'request.json'), body)
        self.write(str(base / 'packages.json'), [{'evidence': {'candidate_id': v}} for v in slot['candidate_ids']])
        state = {'status': status, 'role': role}
        if status == 'cancelled_before_dispatch':
            state.update(dispatched=False, charge_unknown=False)
        self.write(str(base / 'call-state.json'), state)
        rid = slot['batch_name'] + role
        if status == 'response_saved':
            self.write(str(base / 'response.json'), {'id': rid, 'status': 'completed', 'model': 'gpt-6-luna',
                'usage': {'input_tokens': 1000, 'output_tokens': 100, 'input_tokens_details': {'cached_tokens': 200,
                    'cache_write_tokens': 50}, 'output_tokens_details': {'reasoning_tokens': 20}}})
        start, end = ('20:00:40', '20:01:00') if slot['lane'] == 'eligible' else ('20:01:20', '20:01:40')
        common = {'request_hash': base.name, 'model': 'gpt-6-luna', 'role': role, 'attempt': 1, 'pid': 42,
                  'started_at': f'2026-09-30T{start}Z'}
        events = [{**common, 'event': 'request_start'}, {**common, 'event': 'request_end',
            'ended_at': f'2026-09-30T{end}Z', **state, 'response_id': rid if status == 'response_saved' else None,
            'http_status': 200 if status == 'response_saved' else None}]
        (base / 'transport-events.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in events))
        return base

    def report(self):
        return TinyReporter(self.root, 'tiny').run()

    def test_only_tiny_scope_passes_with_prior_queue_pending_and_measured_overlap(self):
        report = self.report()
        self.assertTrue(report['passed'], report['errors'])
        self.assertEqual(report['counts'], {'published': 1, 'held': 4, 'failed': 0, 'pending': 0})
        self.assertFalse(report['all_selected_published'])
        self.assertEqual(report['baseline_record_count'], 1)
        self.assertEqual(len(report['api']['response_ids']), 4)
        self.assertEqual(report['api']['token_categories']['input_tokens_details.cache_write_tokens'], 200)
        self.assertEqual(report['api']['token_categories']['output_tokens_details.reasoning_tokens'], 80)
        self.assertTrue(report['streaming_overlap']['observed'])
        self.assertTrue(any(w['review_started_while_other_preparing'] for w in report['streaming_overlap']['witnesses']))
        self.assertEqual(report['timing']['total_wall_seconds'], 120)
        self.assertTrue(all(r['final_evidence']['checked'] for r in report['coverage']))
        self.assertTrue((self.root / 'tiny-validation-report.md').exists())

    def test_pending_is_not_counted_as_disposed(self):
        (self.root / 'records' / (self.ids[-1] + '.json')).unlink()
        report = self.report()
        self.assertFalse(report['passed'])
        self.assertEqual(report['counts']['pending'], 1)
        self.assertEqual(report['pending_ids'], [self.ids[-1]])

    def test_named_source_failure_is_accurately_reported_not_global_failure(self):
        self.write('records/' + self.ids[-1] + '.json', {'candidate_id': self.ids[-1], 'status': 'failed',
            'stage': 'preparation', 'error': 'HTTP 403 source access denied'})
        report = self.report()
        self.assertTrue(report['passed'], report['errors'])
        self.assertEqual(report['counts']['failed'], 1)
        self.assertEqual(report['coverage'][-1]['failure_category'], 'source_failed')

    def test_baseline_changes_and_new_record_overrun_fail(self):
        self.write('records/' + self.baseline + '.json', {'candidate_id': self.baseline, 'status': 'published'})
        self.write('records/outside0001.json', {'candidate_id': 'outside0001', 'status': 'preparing'})
        report = self.report()
        self.assertFalse(report['passed'])
        self.assertTrue({'baseline_record_changed', 'record_outside_tiny_admission'}.issubset({e['code'] for e in report['errors']}))

    def test_unsigned_plan_or_old_fifty_exclusion_drift_fails(self):
        self.plan['excluded_prior_candidate_ids'] = [self.baseline]
        self.write('stream-plan.json', self.plan)
        report = self.report()
        self.assertFalse(report['passed'])
        self.assertTrue({'stream_plan_hash_drift', 'old_fifty_not_fully_excluded'}.issubset({e['code'] for e in report['errors']}))

    def test_corrupt_final_media_is_not_cleared_by_stale_asr(self):
        media = self.root / 'rendered' / (self.ids[0] + '-final') / 'clip.mp4'
        media.write_bytes(b'changed media')
        report = self.report()
        self.assertFalse(report['passed'])
        self.assertFalse(report['coverage'][0]['final_evidence']['checks']['final_media_hash'])

    def test_cpu_or_nonpersistent_asr_fails_even_with_updated_asr_binding(self):
        directory = self.root / 'rendered' / (self.ids[1] + '-final')
        path = directory / 'asr/clip.json'
        record = json.loads(path.read_text())
        record['provider']['device'] = 'cpu'
        self.write(str(path), record)
        binding = json.loads((directory / 'asr/evidence.json').read_text())
        self.write(str(directory / 'asr/evidence.json'), {**binding, 'asr_sha256': sha(path)})
        self.assertFalse(self.report()['passed'])

    def test_missing_final_qa_and_invalid_publication_receipt_fail(self):
        directory = self.root / 'rendered' / (self.ids[0] + '-final')
        (directory / 'final-qa.json').unlink()
        self.write('publications/' + self.ids[0] + '.json', {'passed': False})
        report = self.report()
        self.assertFalse(report['passed'])
        self.assertFalse(report['coverage'][0]['final_evidence']['checks']['publication_receipt'])

    def test_unsent_stop_intent_is_preserved_but_not_unknown_or_http(self):
        self.request(self.slots[0], 'finalizer', status='cancelled_before_dispatch')
        report = self.report()
        self.assertTrue(report['passed'], report['errors'])
        self.assertEqual(report['transport']['unknown_charge_calls'], [])
        self.assertEqual(len(report['transport']['cancelled_before_dispatch']), 1)
        self.assertEqual(report['transport']['closed_intervals'], 4)
        self.assertEqual(len(report['api']['response_ids']), 4)

    def test_unknown_charge_remains_flagged(self):
        self.request(self.slots[0], 'finalizer', status='unknown_charge')
        report = self.report()
        self.assertFalse(report['passed'])
        self.assertEqual(len(report['transport']['unknown_charge_calls']), 1)

    def test_sixth_revision_and_stale_handoff_binding_fail(self):
        vid = self.ids[1]
        record_path = self.root / 'records' / (vid + '.json')
        record = json.loads(record_path.read_text())
        handoff = self.write('batches/tiny-eligible/handoff/' + vid + '.json', {'artifacts': {
            'media_path': str(Path(record['directory']) / 'clip.mp4'), 'media_sha256': '0' * 64,
            'asr_sha256': '0' * 64, 'recipe_hash': '0' * 64}})
        self.write(str(record_path), {**record, 'handoff': str(handoff.with_suffix('.md'))})
        self.write('batches/tiny-eligible/pipelines/p/ledger.json', {'rounds': [{'pass': 6, 'active_candidates': [vid]}]})
        report = self.report()
        self.assertFalse(report['passed'])
        self.assertIn('revision_exceeds_five_pass_budget', {e['code'] for e in report['errors']})
        self.assertFalse(report['coverage'][1]['final_evidence']['checks']['handoff_hash_binding'])

    def test_no_stage_logs_means_unobserved_overlap_without_invented_timing(self):
        (self.root / 'tiny-stdout.log').unlink()
        report = self.report()
        self.assertTrue(report['passed'], report['errors'])
        self.assertFalse(report['streaming_overlap']['observed'])
        self.assertTrue(all(r['preparation_wall_seconds'] is None for r in report['coverage']))


if __name__ == '__main__':
    unittest.main()
