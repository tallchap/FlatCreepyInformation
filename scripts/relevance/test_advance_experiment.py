import json
from pathlib import Path
import tempfile
import unittest

import advance_experiment as advance
import audit
import production


class AdvanceTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory) / 'run'
        candidates = []
        for lane, count in (('eligible', 105), ('review', 45)):
            for i in range(count):
                vid = lane[0] + f'{i:010}'
                packet = {'candidate_id': vid, 'context_transcript': '[0] source context'}
                candidates.append({'candidate_id': vid, 'lane': lane, 'packet_sha256': audit.digest(packet)})
                audit.atomic(root / 'input/candidates' / f'{vid}.json', packet)
        audit.atomic(root / 'input/manifest.json', {'candidates': candidates})
        first_items = candidates[:35] + candidates[105:120]
        slots = []
        for lane in ('eligible', 'review'):
            items = [row for row in first_items if row['lane'] == lane]
            for i in range(0, len(items), 5):
                part = items[i:i+5]
                slots.append({'batch_name': f'wave1-{lane}-{i//5+1:04d}', 'lane': lane,
                              'items': part, 'candidate_ids': [row['candidate_id'] for row in part]})
        baseline = {'candidate_id': 'oldbaseline', 'status': 'already_published'}
        audit.atomic(root / 'records/oldbaseline.json', baseline)
        first = {'experiment_id': 'wave1', 'candidate_ids': [row['candidate_id'] for row in first_items],
                 'slots': slots, 'manifest_sha256': advance.sha(root / 'input/manifest.json'),
                 'baseline_record_sha256': {'oldbaseline': advance.sha(root / 'records/oldbaseline.json')},
                 'baseline_luna_cost_usd': 0, 'baseline_shadow_cost_usd': 0}
        first['plan_sha256'] = audit.digest(first)
        audit.atomic(root / 'experiment-plan.json', first)
        for vid in first['candidate_ids']:
            audit.atomic(root / 'records' / f'{vid}.json', {'candidate_id': vid, 'status': 'awaiting_astra',
                'stage': 'proposal', 'reason': 'Proposal requires review', 'packet_path': str(root / 'input/candidates' / f'{vid}.json')})
        audit.atomic(root / 'experiment-status.json', {'experiment_id': 'wave1', 'phase': 'experiment_completed', 'finished_at': audit.now()})
        audit.atomic(root / 'benchmark-report.json', {'experiment_id': 'wave1',
            'authorized': {'frozen_ids': first['candidate_ids']},
            'checks': {key: True for key in ('integrity', 'exact_fifty_coverage', 'all_fifty_disposed', 'no_overrun', 'experiment_finished')},
            'transport': {'unknown_or_unmatched': []}, 'api': {'usage_derived_cost_usd': 0}})
        audit.atomic(root / 'supervisor.json', {'attempt': 2, 'phase': 'complete'})
        audit.atomic(root / 'code-verification.json', {'passed': True})
        audit.atomic(root / 'failure-analysis.json', {'failures': []})
        receipt = root / 'checkpoint-delivery.json'
        audit.atomic(receipt, {'experiment_id': 'wave1', 'job_id': advance.JOB_ID, 'verified': True,
            'verification_scope': advance.RECEIPT_SCOPE, 'asset_id': 'relay-real-receipt-placeholder',
            'bundle_sha256': 'a'*64, 'manifest_sha256': 'b'*64, 'sent_at': audit.now()})
        return root, receipt, first

    def test_archives_and_admits_only_disjoint_35_plus_15_then_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, first = self.fixture(tmp)
            before = {path.name: path.read_bytes() for path in (root / 'records').glob('*.json')}
            original_plan = (root / 'experiment-plan.json').read_bytes()
            result = advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            second = advance.read(root / 'experiment-plan.json')
            self.assertEqual(result['stage'], 'complete')
            self.assertEqual(len(second['candidate_ids']), 50)
            self.assertEqual(len(set(second['cumulative_candidate_ids'])), 100)
            self.assertFalse(set(first['candidate_ids']) & set(second['candidate_ids']))
            self.assertEqual([slot['lane'] for slot in second['slots']], ['eligible']*7 + ['review']*3)
            self.assertEqual((root / 'experiments/wave1/artifacts/experiment-plan.json').read_bytes(), original_plan)
            self.assertFalse((root / 'experiment-status.json').exists())
            self.assertFalse((root / 'supervisor.json').exists())
            self.assertEqual(before, {path.name: path.read_bytes() for path in (root / 'records').glob('*.json')})
            audit.atomic(root / 'experiment-status.json', {'experiment_id': 'wave2', 'phase': 'running'})
            self.assertEqual(advance.advance_experiment(root, 'wave1', 'wave2', receipt), result)
            self.assertEqual(advance.read(root / 'experiment-status.json')['phase'], 'running')
            with self.assertRaisesRegex(ValueError, 'maximum two waves'):
                advance.advance_experiment(root, 'wave2', 'wave3', receipt)

    def test_nonterminal_first_candidate_blocks_all_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, first = self.fixture(tmp)
            audit.atomic(root / 'records' / f"{first['candidate_ids'][0]}.json", {'candidate_id': first['candidate_ids'][0], 'status': 'reviewing'})
            with self.assertRaisesRegex(ValueError, 'not terminal'):
                advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            self.assertFalse((root / 'experiment-transition.json').exists())
            self.assertEqual(advance.read(root / 'experiment-plan.json')['experiment_id'], 'wave1')

    def test_both_live_locks_block_transition(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, _ = self.fixture(tmp)
            for name in ('supervisor.lock', 'runner.lock'):
                with self.subTest(lock=name), production.runner_lock(root / name):
                    with self.assertRaises(OSError):
                        advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            self.assertFalse((root / 'experiment-transition.json').exists())

    def test_checkpoint_receipt_and_baseline_hash_are_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, _ = self.fixture(tmp)
            saved = receipt.read_bytes()
            audit.atomic(receipt, {'verified': True})
            with self.assertRaisesRegex(ValueError, 'committed Relay checkpoint'):
                advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            receipt.write_bytes(saved)
            audit.atomic(root / 'records/oldbaseline.json', {'candidate_id': 'oldbaseline', 'status': 'failed'})
            with self.assertRaisesRegex(ValueError, 'baseline record changed'):
                advance.advance_experiment(root, 'wave1', 'wave2', receipt)

    def test_unknown_charge_is_preserved_only_with_explicit_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, _ = self.fixture(tmp)
            report = advance.read(root / 'benchmark-report.json')
            report['transport']['unknown_or_unmatched'] = [{'request_hash': 'unknown', 'charge_unknown': True}]
            audit.atomic(root / 'benchmark-report.json', report)
            audit.atomic(root / 'batches/wave1-eligible-0001/unknown/request.json', {'model': 'gpt-6-luna'})
            audit.atomic(root / 'batches/wave1-eligible-0001/unknown/call-state.json', {'status': 'unknown_charge'})
            with self.assertRaisesRegex(ValueError, 'preserve-unknown-charges'):
                advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            advance.advance_experiment(root, 'wave1', 'wave2', receipt, preserve_unknown_charges=True)
            second = advance.read(root / 'experiment-plan.json')
            self.assertEqual(second['preserved_unknown_charge_count'], 1)
            self.assertEqual(second['baseline_request_paths'], ['batches/wave1-eligible-0001/unknown/request.json'])
            self.assertEqual(advance.read(root / 'batches/wave1-eligible-0001/unknown/call-state.json')['status'], 'unknown_charge')

    def test_stale_report_cannot_hide_outside_request_or_reused_next_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, _ = self.fixture(tmp)
            request = root / 'batches/unauthorized-group/unknown/request.json'
            audit.atomic(request, {'model': 'gpt-6-luna'})
            with self.assertRaisesRegex(ValueError, 'Unreported request outside first wave'):
                advance.advance_experiment(root, 'wave1', 'wave2', receipt, preserve_unknown_charges=True)
            request.unlink()
            (root / 'batches/wave2-eligible-0001').mkdir()
            with self.assertRaisesRegex(ValueError, 'namespace already contains artifacts'):
                advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            self.assertFalse((root / 'experiment-transition.json').exists())

    def test_failed_preparation_without_directory_keeps_render_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, first = self.fixture(tmp)
            vid = first['candidate_ids'][0]
            audit.atomic(root / 'records' / f'{vid}.json', {'candidate_id': vid, 'status': 'failed',
                'stage': 'preparation', 'error': 'Range transfer errors'})
            directory = root / 'rendered' / (vid + '-identity')
            audit.atomic(directory / 'recipe.json', {'candidate_id': vid})
            audit.atomic(directory / 'transfer.json', {'errors': ['disconnect']})
            audit.atomic(directory / 'source-ffprobe.json', {'streams': []})
            (directory / 'part-000.log').write_text('diagnostic', encoding='utf-8')
            (directory / 'part-000.mp4').write_bytes(b'partial-media-preserved')
            advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            copied = root / 'experiments/wave1/artifacts/rendered' / directory.name
            self.assertEqual(advance.read(copied / 'transfer.json'), {'errors': ['disconnect']})
            self.assertTrue((copied / 'source-ffprobe.json').exists())
            self.assertTrue((copied / 'part-000.log').exists())
            self.assertFalse((copied / 'part-000.mp4').exists())
            self.assertEqual((directory / 'part-000.mp4').read_bytes(), b'partial-media-preserved')

    def test_recovers_each_partial_commit_without_reselecting_or_losing_history(self):
        for failpoint in ('journal_prepared', 'archive_finalized', 'metadata_reset', 'journal_committed', 'plan_installed'):
            with self.subTest(failpoint=failpoint), tempfile.TemporaryDirectory() as tmp:
                root, receipt, first = self.fixture(tmp)

                def crash(step):
                    if step == failpoint:
                        raise RuntimeError('simulated interruption')
                with self.assertRaisesRegex(RuntimeError, 'simulated'):
                    advance.advance_experiment(root, 'wave1', 'wave2', receipt, _after_step=crash)
                journal_before = advance.read(root / 'experiment-transition.json')
                result = advance.advance_experiment(root, 'wave1', 'wave2', receipt)
                self.assertEqual(result['stage'], 'complete')
                self.assertEqual(result['next_plan_sha256'], journal_before['next_plan_sha256'])
                self.assertEqual(result['archive_manifest_sha256'], journal_before['archive_manifest_sha256'])
                archived = advance.read(root / 'experiments/wave1/artifacts/experiment-plan.json')
                self.assertEqual(archived, first)

    def test_publication_and_handoff_hashes_rechecked_including_null_ledger_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, first = self.fixture(tmp)
            pub_id, hold_id = first['candidate_ids'][:2]
            pub, hold = root / 'rendered' / pub_id, root / 'rendered' / hold_id
            for directory, vid in ((pub, pub_id), (hold, hold_id)):
                audit.atomic(directory / 'recipe.json', {'candidate_id': vid, 'edits': []})
                (directory / 'clip.mp4').write_bytes(b'fixture-media')
                audit.atomic(directory / 'asr/clip.json', {'text': 'fixture speech'})
            gate = {'policy_version': production.luna.RELEASE_POLICY_VERSION, 'passed': True,
                    'min_release_confidence': .95, 'release_confidence': .99, 'escalation_reasons': []}
            qa = {'passed': True, 'release_gate': gate, 'media_sha256': advance.sha(pub / 'clip.mp4'),
                  'recipe_hash': audit.digest(advance.read(pub / 'recipe.json'))}
            audit.atomic(pub / 'final-qa.json', qa)
            publication = root / 'publications' / f'{pub_id}.json'
            audit.atomic(publication, {**qa, 'video_id': pub_id})
            audit.atomic(root / 'records' / f'{pub_id}.json', {'candidate_id': pub_id, 'status': 'published',
                'publication_receipt': str(publication), 'final_directory': str(pub)})
            handoff = root / 'batches/wave1-eligible-0001/pipeline/astra-escalations' / f'{hold_id}.json'
            audit.atomic(handoff, {'candidate_id': hold_id, 'status': 'awaiting_astra',
                'reason': 'No independent verifier PASS within five rounds', 'artifacts': {
                    'media_path': str(hold / 'clip.mp4'), 'media_sha256': advance.sha(hold / 'clip.mp4'),
                    'recipe_path': str(hold / 'recipe.json'), 'recipe_hash': audit.digest(advance.read(hold / 'recipe.json')),
                    'asr_path': str(hold / 'asr/clip.json'), 'asr_sha256': advance.sha(hold / 'asr/clip.json')}})
            handoff.with_suffix('.md').write_text('Pending Astra review', encoding='utf-8')
            audit.atomic(root / 'records' / f'{hold_id}.json', {'candidate_id': hold_id, 'status': 'awaiting_astra',
                'handoff': str(handoff.with_suffix('.md')), 'reason': None})
            manifest = advance.read(root / 'input/manifest.json')
            advance.validate_first_wave(root, first, manifest, False)
            media_bytes = (pub / 'clip.mp4').read_bytes()
            (pub / 'clip.mp4').write_bytes(b'drift')
            with self.assertRaisesRegex(ValueError, 'Publication media'):
                advance.validate_first_wave(root, first, manifest, False)
            (pub / 'clip.mp4').write_bytes(media_bytes)
            asr_bytes = (hold / 'asr/clip.json').read_bytes()
            (hold / 'asr/clip.json').write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Astra evidence hash drift'):
                advance.validate_first_wave(root, first, manifest, False)
            (hold / 'asr/clip.json').write_bytes(asr_bytes)
            advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            archived = root / 'experiments/wave1/artifacts/rendered'
            self.assertTrue((archived / pub_id / 'final-qa.json').exists())
            self.assertTrue((archived / hold_id / 'asr/clip.json').exists())
            self.assertFalse(list(archived.rglob('*.mp4')))

    def test_archival_corruption_blocks_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, receipt, _ = self.fixture(tmp)
            with self.assertRaises(RuntimeError):
                advance.advance_experiment(root, 'wave1', 'wave2', receipt,
                    _after_step=lambda step: (_ for _ in ()).throw(RuntimeError()) if step == 'archive_finalized' else None)
            (root / 'experiments/wave1/artifacts/code-verification.json').write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'archive artifact changed'):
                advance.advance_experiment(root, 'wave1', 'wave2', receipt)
            self.assertEqual(advance.read(root / 'experiment-plan.json')['experiment_id'], 'wave1')


if __name__ == '__main__':
    unittest.main()
