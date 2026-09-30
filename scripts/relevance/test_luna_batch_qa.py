import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import audit
import luna_batch_qa as qa


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.clip = self.root / 'clip'
        self.clip.mkdir()
        (self.clip / 'asr').mkdir()
        self.packets = self.root / 'packets'
        self.packets.mkdir()
        self.vid = 'abcdefghijk'
        self.recipe = {'schema_version': 'snippy-astra-edit-v1', 'candidate_id': self.vid, 'source_input_hash': 'source', 'title': 'Title', 'speaker': 'Expert', 'decision': 'revise', 'reason': 'FINALIZER SECRET', 'edit_notes': 'FINALIZER NOTES', 'clip_worthy': True, 'edits': [{'start_seconds': 100, 'end_seconds': 140, 'transcript': 'full original caption'}]}
        self.write(self.clip / 'recipe.json', self.recipe)
        (self.clip / 'clip.mp4').write_bytes(b'fake-media-fixture')
        (self.clip / 'contact.jpg').write_bytes(b'fake-image-fixture')
        self.write(self.clip / 'result.json', {'candidate_id': self.vid, 'source_input_hash': 'source', 'source_generation': '1', 'output_sha256': qa.sha(self.clip / 'clip.mp4'), 'duration_seconds': 40, 'transfer': {'upstream_body_bytes_read': 123}})
        self.write(self.clip / 'qa.json', {'checks': {'video': True, 'audio': True, 'duration': True}, 'ffprobe': {'streams': [{'codec_type': 'video', 'width': 160, 'height': 90}, {'codec_type': 'audio'}]}})
        self.write(self.clip / 'asr/clip.json', {'segments': [{'words': [{'start': n * 5, 'end': (n + 1) * 5, 'word': 'word' + str(n)} for n in range(8)]}]})
        self.write(self.packets / f'{self.vid}.json', {'source_input_hash': 'source', 'gcs_object': {'generation': '1'}, 'context_transcript': '[90] before\n[100] complete original caption\n[150] after'})
        self.p = qa.package(self.clip, self.packets)

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))

    def decision(self, p=None, status='approve', **kw):
        e = (p or self.p)['evidence']
        return {**{k: e[k] for k in qa.IDENTITIES}, 'retained_speaker': e['recipe']['speaker'], 'final_title': e['recipe']['title'], 'final_description': e.get('publication_metadata', {}).get('description', e['recipe'].get('reason', 'A substantive AI claim.')), 'metadata_status': 'pass', 'status': status, 'reason': 'Complete claim', 'preserves_meaning': True, 'keep_start_seconds': None, 'keep_end_seconds': None, 'picture_status': 'pass', 'dialogue_status': 'pass', 'boundaries_status': 'pass', **kw}

    def raw(self, decisions):
        return {'id': 'r1', 'status': 'completed', 'usage': {'input_tokens': 100, 'output_tokens': 10}, 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps({'decisions': [{k: v for k, v in d.items() if k in qa.PROPS} for d in decisions]})}]}]}

    def normalize(self, raw, packages, output):
        body = qa.build_request(packages)
        audit.atomic(output / 'request.json', body)
        raw['metadata'] = copy.deepcopy(body['metadata'])
        return qa.normalize(raw, packages, output, body)

    def test_exact_batch_coverage_and_hashes(self):
        d = self.decision()
        for decisions in ([], [d, d], [dict(d, candidate_id='extra')]):
            with self.subTest(decisions=decisions):
                with self.assertRaises(ValueError):
                    self.normalize(self.raw(decisions), [self.p], self.root / 'out')

    def test_server_attaches_hashes_without_model_copying_them(self):
        body = qa.build_request([self.p])
        self.assertEqual(set(qa.IDENTITIES).intersection(qa.PROPS), {'candidate_id'})
        self.assertNotIn(self.p['evidence']['media_sha256'], body['input'][0]['content'][0]['text'])
        raw = self.raw([self.decision(media_sha256='one-wrong-hex-character')])
        result = self.normalize(raw, [self.p], self.root / 'out')
        self.assertEqual(result['decisions'][0]['media_sha256'], self.p['evidence']['media_sha256'])
        self.assertEqual(result['decisions'][0]['status'], 'approve')

    def test_response_and_persisted_request_binding_mismatch_fail_closed(self):
        body = qa.build_request([self.p])
        output = self.root / 'out'
        audit.atomic(output / 'request.json', body)
        raw = self.raw([self.decision()])
        for metadata in (None, {}, {**body['metadata'], 'batch_evidence_hash': 'wrong'}, {**body['metadata'], 'request_fingerprint': 'wrong'}):
            raw['metadata'] = metadata
            with self.assertRaisesRegex(ValueError, 'binding'):
                qa.normalize(raw, [self.p], output, body)
        raw['metadata'] = body['metadata']
        audit.atomic(output / 'request.json', {**body, 'model': 'different'})
        with self.assertRaisesRegex(ValueError, 'Persisted request mismatch'):
            qa.normalize(raw, [self.p], output, body)
        audit.atomic(output / 'request.json', body)
        altered = copy.deepcopy(self.p)
        altered['evidence']['duration_seconds'] = 30
        with self.assertRaisesRegex(ValueError, 'batch evidence binding'):
            qa.normalize(raw, [altered], output, body)

    def test_approval_requires_technical_asr_frames_and_all_checks(self):
        for change in ({'technical_pass': False}, {'asr_words': []}, {'image_sha256': None}):
            p = copy.deepcopy(self.p)
            p['evidence'].update(change)
            if change.get('image_sha256', 'present') is None:
                p['image_path'] = None
            p['evidence'].pop('evidence_hash')
            p['evidence']['evidence_hash'] = audit.digest(p['evidence'])
            result = self.normalize(self.raw([self.decision(p)]), [p], self.root / 'out')
            self.assertEqual(result['decisions'][0]['status'], 'review')
            self.assertFalse(result['decisions'][0]['automatic_release_eligible'])
        result = self.normalize(self.raw([self.decision(boundaries_status='uncertain')]), [self.p], self.root / 'out')
        self.assertEqual(result['decisions'][0]['status'], 'review')

    def test_adjust_is_exact_word_bound_local_trim(self):
        d = self.decision(status='adjust', keep_start_seconds=5, keep_end_seconds=25)
        result = self.normalize(self.raw([d]), [self.p], self.root / 'out')
        plan = qa.read(result['decisions'][0]['trim_path'])
        self.assertEqual(plan['source_ranges'], [{'start_seconds': 105, 'end_seconds': 125}])
        self.assertEqual(plan['transcript'], 'word1 word2 word3 word4')
        for start, end in ((5.1, 25), (-5, 25), (5, 50), (5, 10), (float('nan'), 25)):
            with self.assertRaises(ValueError):
                qa.trim_plan(self.p['evidence'], start, end)

    def test_invalid_trim_isolated_from_valid_neighbor(self):
        other = self.root / 'other'
        shutil.copytree(self.clip, other)
        vid = 'lmnopqrstuv'
        for name in ('recipe.json', 'result.json'):
            data = qa.read(other / name); data['candidate_id'] = vid
            self.write(other / name, data)
        shutil.copyfile(self.packets / f'{self.vid}.json', self.packets / f'{vid}.json')
        p2 = qa.package(other, self.packets)
        bad = self.decision(status='adjust', keep_start_seconds=5.123, keep_end_seconds=25)
        result = self.normalize(self.raw([bad, self.decision(p2)]), [self.p, p2], self.root / 'out')
        failed, good = result['decisions']
        self.assertEqual(failed['status'], 'review')
        self.assertIn('ASR word boundaries', failed['action_validation_error'])
        self.assertFalse(failed['automatic_release_eligible'])
        self.assertNotIn('trim_path', failed)
        self.assertEqual(good['status'], 'approve')

    def test_invalid_metadata_isolated_from_valid_neighbor(self):
        other = self.root / 'other'
        shutil.copytree(self.clip, other)
        vid = 'lmnopqrstuv'
        for name in ('recipe.json', 'result.json'):
            data = qa.read(other / name)
            data['candidate_id'] = vid
            self.write(other / name, data)
        shutil.copyfile(self.packets / f'{self.vid}.json', self.packets / f'{vid}.json')
        p2 = qa.package(other, self.packets)
        original_recipe = (self.clip / 'recipe.json').read_bytes()
        for fields in ({'retained_speaker': 'Sagar'}, {'final_title': ''}, {'final_description': 'x' * 4001}):
            with self.subTest(fields=fields):
                bad = self.decision(status='adjust', keep_start_seconds=5, keep_end_seconds=25, **fields)
                result = self.normalize(self.raw([bad, self.decision(p2)]), [self.p, p2], self.root / 'out')
                failed, good = result['decisions']
                self.assertEqual(failed['status'], 'review')
                self.assertIn('Invalid proposed metadata', failed['action_validation_error'])
                self.assertFalse(failed['automatic_release_eligible'])
                self.assertIsNone(failed['keep_start_seconds'])
                self.assertNotIn('trim_path', failed)
                self.assertEqual(good['status'], 'approve')
                self.assertEqual((self.clip / 'recipe.json').read_bytes(), original_recipe)

    def test_invalid_action_cannot_pass_even_if_verifier_approves_current_media(self):
        def reviewer(packages, output, role):
            decision = self.decision(packages[0], status='review' if role == 'finalizer' else 'approve')
            decision['automatic_release_eligible'] = role == 'verifier'
            if role == 'finalizer': decision['action_validation_error'] = 'Invalid timestamp'
            return {'response_id': role, 'cost_usd': 0, 'decisions': [decision]}
        with patch.object(qa, 'review_packages', side_effect=reviewer):
            result = qa.pipeline(self.args())
        self.assertFalse(result['all_complete'])
        self.assertEqual(result['decisions'][0]['attempts'], 5)
        self.assertFalse((self.clip / 'final-qa.json').exists())

    def test_legacy_trim_plan_without_speaker_binding_reuses_original_cache(self):
        plan = qa.trim_plan(self.p['evidence'], 5, 25)
        plan.pop('source_speaker_evidence', None)
        plan.update(parent_clip_dir=str(self.clip), reason='Saved before speaker evidence was added')
        path = self.root / 'legacy-trim.json'
        self.write(path, plan)
        original_bytes = path.read_bytes()
        output = self.root / 'legacy-output'
        cached_dir = output / f"{self.vid}-{audit.digest(plan)[:20]}"
        cached_dir.mkdir(parents=True)
        shutil.copyfile(self.clip / 'clip.mp4', cached_dir / 'clip.mp4')
        cached = {'candidate_id': self.vid, 'output_sha256': qa.sha(cached_dir / 'clip.mp4')}
        self.write(cached_dir / 'result.json', cached)
        with patch.object(qa, 'run', side_effect=AssertionError('Legacy cache must not re-render')):
            self.assertEqual(qa.execute_trim(path, output), cached)
        self.assertEqual(path.read_bytes(), original_bytes)
        self.assertEqual(list(output.iterdir()), [cached_dir])
        plan['retained_speaker'] = 'Invented Person'
        self.write(path, plan)
        with patch.object(qa, 'run', side_effect=AssertionError('Must reject before render')):
            with self.assertRaisesRegex(ValueError, 'not an invented name'):
                qa.execute_trim(path, output)

    def test_gap_handles_never_overlap_excluded_words(self):
        evidence = copy.deepcopy(self.p['evidence'])
        evidence['asr_words'] = [{'start': n * 5 + 1, 'end': n * 5 + 4, 'text': 'word' + str(n)} for n in range(8)]
        plan = qa.trim_plan(evidence, 6, 29)
        self.assertAlmostEqual(plan['keep_start_seconds'], 5.88)
        self.assertAlmostEqual(plan['keep_end_seconds'], 29.15)
        self.assertGreater(plan['keep_start_seconds'], evidence['asr_words'][0]['end'])
        self.assertLess(plan['keep_end_seconds'], evidence['asr_words'][6]['start'])
        self.assertEqual(plan['selected_word_start_seconds'], 6)
        self.assertEqual(plan['selected_word_end_seconds'], 29)
        no_gap = qa.trim_plan(self.p['evidence'], 5, 25)
        self.assertEqual(no_gap['boundary_handles']['opening_seconds'], 0)
        self.assertEqual(no_gap['boundary_handles']['closing_seconds'], 0)

    def test_correction_can_restore_opening_from_original_after_bad_trim(self):
        bad = self.root / 'bad-cut'
        shutil.copytree(self.clip, bad)
        bad_plan = qa.trim_plan(self.p['evidence'], 10, 35)
        bad_plan.update(parent_clip_dir=str(self.clip), reason='Bad aggressive opening')
        self.write(bad / 'trim.json', bad_plan)
        recipe = copy.deepcopy(self.recipe)
        recipe['edits'] = [{'start_seconds': 110, 'end_seconds': 135, 'transcript': 'word2 word3 word4 word5 word6'}]
        self.write(bad / 'recipe.json', recipe)
        result = qa.read(bad / 'result.json')
        result['duration_seconds'] = 25
        self.write(bad / 'result.json', result)
        self.write(bad / 'asr/clip.json', {'words': [{'start': n * 5, 'end': (n + 1) * 5, 'word': 'word' + str(n + 2)} for n in range(5)]})
        p = qa.finalizer_package(self.clip, bad, self.packets, feedback={'reason': 'Opening clipped'}, review_round=2, experiment_id='restore-test')
        qa.recheck(p)
        self.assertEqual(p['clip_dir'], str(self.clip.resolve()))
        self.assertEqual(p['evidence']['current_cut']['original_start_seconds'], 10)
        self.assertEqual(p['evidence']['asr_words'][1]['text'], 'word1')
        raw = self.raw([self.decision(p, status='adjust', keep_start_seconds=5, keep_end_seconds=35)])
        normalized = self.normalize(raw, [p], self.root / 'out')
        plan = qa.read(normalized['decisions'][0]['trim_path'])
        self.assertEqual(plan['parent_clip_dir'], str(self.clip.resolve()))
        self.assertEqual(plan['source_ranges'][0]['start_seconds'], 105)
        self.assertTrue(plan['transcript'].startswith('word1'))
        self.assertEqual(plan['attempt'], 1)  # One encode from original, not a child-of-child.

    def test_speaker_only_fix_preserves_original_and_media(self):
        recipe = qa.read(self.clip / 'recipe.json')
        recipe['speaker'] = 'Gary Marcus and interviewer'
        self.write(self.clip / 'recipe.json', recipe)
        target = qa.apply_speaker_metadata(self.clip, 'Gary Marcus', self.root / 'fixed')
        self.assertEqual(qa.sha(target / 'clip.mp4'), qa.sha(self.clip / 'clip.mp4'))
        self.assertEqual(qa.read(target / 'recipe.json')['speaker'], 'Gary Marcus')
        self.assertEqual(qa.read(self.clip / 'recipe.json')['speaker'], 'Gary Marcus and interviewer')
        with self.assertRaisesRegex(ValueError, 'invented name'):
            qa.apply_speaker_metadata(self.clip, 'Different Person', self.root / 'fixed')

    def test_publication_metadata_fix_preserves_history_without_encoding(self):
        original = qa.read(self.clip / 'recipe.json')
        original.update(reason='Provisional envelope; include the interviewer question.', edit_notes='Trim later after review')
        self.write(self.clip / 'recipe.json', original)
        with patch.object(qa, 'run', side_effect=AssertionError('Metadata fix must not encode or call ASR')):
            target = qa.apply_publication_metadata(self.clip, 'Expert', 'Expert explains AI oversight', 'The expert describes oversight challenges for increasingly capable AI.', self.root / 'fixed')
        result = qa.read(target / 'recipe.json')
        self.assertEqual(result['reason'], 'The expert describes oversight challenges for increasingly capable AI.')
        self.assertEqual(result['edit_notes'], '')
        self.assertEqual(qa.read(target / 'parent-recipe.json'), original)
        self.assertEqual(qa.read(self.clip / 'recipe.json'), original)
        self.assertEqual(qa.sha(target / 'clip.mp4'), qa.sha(self.clip / 'clip.mp4'))
        p = qa.current_package(target, self.packets, feedback={'reason': 'PRIVATE APPROVAL RATIONALE'}, verifier=True)
        self.assertEqual(p['evidence']['publication_metadata']['description'], result['reason'])
        self.assertNotIn('PRIVATE APPROVAL RATIONALE', json.dumps(p['evidence']))
        self.assertNotIn('Provisional envelope', json.dumps(p['evidence']))

    def test_metadata_fail_or_meaning_uncertainty_blocks_approval(self):
        for changes in ({'metadata_status': 'fail'}, {'preserves_meaning': False}):
            result = self.normalize(self.raw([self.decision(**changes)]), [self.p], self.root / 'out')
            self.assertEqual(result['decisions'][0]['status'], 'review')
            self.assertFalse(result['decisions'][0]['automatic_release_eligible'])

    def test_trim_plan_carries_publishable_metadata_separate_from_rationale(self):
        decision = self.decision(status='adjust', keep_start_seconds=5, keep_end_seconds=25, final_title='A retained claim', final_description='The expert explains the retained claim.', reason='Remove the broken question')
        result = self.normalize(self.raw([decision]), [self.p], self.root / 'out')
        plan = qa.read(result['decisions'][0]['trim_path'])
        self.assertEqual(plan['final_description'], 'The expert explains the retained claim.')
        self.assertEqual(plan['reason'], 'Remove the broken question')
        self.assertNotEqual(plan['final_description'], plan['reason'])

    def test_verifier_cannot_approve_wrong_stored_speaker(self):
        recipe = qa.read(self.clip / 'recipe.json')
        recipe['speaker'] = 'Gary Marcus and interviewer'
        self.write(self.clip / 'recipe.json', recipe)
        p = qa.current_package(self.clip, self.packets, verifier=True)
        body = qa.build_request([p])
        body['instructions'] = qa.VERIFIER_PROMPT.read_text()
        qa.bind_request(body, [p])
        output = self.root / 'out'
        audit.atomic(output / 'request.json', body)
        raw = self.raw([self.decision(p, retained_speaker='Gary Marcus')])
        raw['metadata'] = body['metadata']
        result = qa.normalize(raw, [p], output, body)
        self.assertEqual(result['decisions'][0]['status'], 'review')
        self.assertFalse(result['decisions'][0]['automatic_release_eligible'])

    def test_recheck_rejects_media_asr_recipe_drift(self):
        for path in ('clip.mp4', 'asr/clip.json', 'recipe.json'):
            target = self.clip / path
            original = target.read_bytes()
            if path == 'recipe.json':
                value = json.loads(original)
                value['title'] = 'Drifted title'
                self.write(target, value)
            else:
                target.write_bytes(original + b' ')
            with self.assertRaises(ValueError):
                qa.recheck(self.p)
            target.write_bytes(original)

    def test_verifier_does_not_receive_finalizer_opinion(self):
        p = qa.current_package(self.clip, self.packets, feedback={'private': 'bad verdict'}, verifier=True, review_round=2, experiment_id='test')
        text = json.dumps(p['evidence'])
        self.assertNotIn('reason', p['evidence']['recipe'])
        self.assertNotIn('edit_notes', p['evidence']['recipe'])
        self.assertEqual(p['evidence']['publication_metadata']['description'], 'FINALIZER SECRET')
        self.assertEqual(p['evidence']['publication_metadata']['publication_edit_notes'], 'FINALIZER NOTES')
        self.assertNotIn('bad verdict', text)
        qa.recheck(p)

    def args(self):
        return SimpleNamespace(images=[], clips=[self.clip], packets=self.packets, whisper_cli='must-not-run', output=self.root / 'out', run_id='test')

    def test_only_verifier_pass_completes_and_cached_pipeline_does_not_call(self):
        calls = []
        def reviewer(packages, output, role):
            calls.append(role)
            p = packages[0]
            return {'response_id': role, 'cost_usd': .1, 'decisions': [{**self.decision(p, status='review' if role == 'finalizer' else 'approve'), 'automatic_release_eligible': role == 'verifier'}]}
        with patch.object(qa, 'review_packages', side_effect=reviewer):
            result = qa.pipeline(self.args())
            self.assertTrue(result['all_complete'])
            self.assertEqual(result['decisions'][0]['status'], 'pass')
            self.assertEqual(calls, ['finalizer', 'verifier'])
            self.assertTrue((self.clip / 'final-qa.json').exists())
            resumed = qa.pipeline(self.args())
            self.assertTrue(resumed['cache_hit'])
            self.assertEqual(resumed['new_cost_usd'], 0)
            self.assertEqual(resumed['decisions'], result['decisions'])
            self.assertEqual(len(calls), 2)

    def test_five_failed_verifier_rounds_escalate_never_complete(self):
        calls = []
        def reviewer(packages, output, role):
            calls.append(role)
            p = packages[0]
            return {'response_id': str(len(calls)), 'cost_usd': .1, 'decisions': [{**self.decision(p, status='approve' if role == 'finalizer' else 'review'), 'automatic_release_eligible': role == 'finalizer'}]}
        with patch.object(qa, 'review_packages', side_effect=reviewer):
            result = qa.pipeline(self.args())
        self.assertEqual(len(calls), 10)
        self.assertFalse(result['all_complete'])
        self.assertEqual(result['decisions'][0]['status'], 'escalated')
        self.assertEqual(len(result['decisions'][0]['history']), 5)
        self.assertTrue(Path(result['decisions'][0]['astra_escalation_path']).exists())
        self.assertFalse((self.clip / 'final-qa.json').exists())

    def test_fresh_run_id_changes_review_round_input(self):
        first = qa.current_package(self.clip, self.packets, review_round=1, experiment_id='one')
        second = qa.current_package(self.clip, self.packets, review_round=1, experiment_id='two')
        self.assertNotEqual(audit.digest(qa.build_request([first])), audit.digest(qa.build_request([second])))

    def test_asr_binding_detects_stale_file(self):
        qa.ensure_asr(self.clip, 'never-call')
        (self.clip / 'asr/clip.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Stale ASR'):
            qa.ensure_asr(self.clip, 'never-call')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_real_trim_updates_recipe_transcript_and_technical_qa(self):
        video = self.clip / 'clip.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '40', '-c:v', 'libx264', '-c:a', 'aac', str(video)], check=True, capture_output=True)
        result = qa.read(self.clip / 'result.json')
        result['output_sha256'] = qa.sha(video)
        self.write(self.clip / 'result.json', result)
        p = qa.package(self.clip, self.packets)
        plan = qa.trim_plan(p['evidence'], 5, 25, final_title='Actual retained title', final_description='Actual retained dialogue description.')
        plan.update(parent_clip_dir=str(self.clip), reason='Remove incomplete edges')
        path = self.root / 'trim.json'
        self.write(path, plan)
        trimmed = qa.execute_trim(path, self.root / 'trimmed')
        directory = Path(trimmed['clip_path']).parent
        revised = qa.read(directory / 'recipe.json')
        self.assertEqual(revised['edits'], [{'start_seconds': 105, 'end_seconds': 125, 'transcript': 'word1 word2 word3 word4'}])
        self.assertEqual(revised['title'], 'Actual retained title')
        self.assertEqual(revised['reason'], 'Actual retained dialogue description.')
        self.assertEqual(revised['edit_notes'], '')
        self.assertEqual(trimmed['additional_gcs_bytes_read'], 0)
        self.assertTrue(all(trimmed['automated_qa'].values()))
        self.assertEqual(qa.execute_trim(path, self.root / 'trimmed')['output_sha256'], trimmed['output_sha256'])
        self.assertTrue((directory / 'parent-recipe.json').exists())


if __name__ == '__main__':
    unittest.main()
