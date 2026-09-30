from pathlib import Path
import tempfile
import unittest

import audit
from preparation_timing import PreparationTiming, summary, union_seconds


class PreparationTimingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ids = [f'a{i:010d}' for i in range(50)]
        self.plan = {'experiment_id':'wave-one','candidate_ids':self.ids,
            'slots':[{'lane':'eligible' if i<7 else 'review','candidate_ids':self.ids[i*5:i*5+5]} for i in range(10)]}
        self.status = {'experiment_id':'wave-one','started_at':'2026-09-30T20:00:00Z',
                       'preparation_started_at':'2026-09-30T20:00:00Z'}
        self.write('experiment-plan.json',self.plan)
        self.write('experiment-status.json',self.status)

    def write(self,name,value):
        path=self.root/name
        audit.atomic(path,value)
        return path

    def log(self,events,path='production-attempt-1.log'):
        file=self.root/path
        file.parent.mkdir(parents=True,exist_ok=True)
        file.write_text(''.join(f'{time} {vid} {stage}\n' for time,vid,stage in events),encoding='utf-8')
        return file

    def artifacts(self):
        directory='rendered/'+self.ids[0]+'-sample'
        transfer={'elapsed_seconds':40,'requests':[
            {'started_at':'2026-09-30T20:00:20Z','finished_at':'2026-09-30T20:00:40Z'},
            {'started_at':'2026-09-30T20:00:30Z','finished_at':'2026-09-30T20:00:50Z'}]}
        self.write(directory+'/result.json',{'created_at':'2026-09-30T20:00:59Z','elapsed_seconds':50,'duration_seconds':60})
        self.write(directory+'/transfer.json',transfer)
        self.write(directory+'/asr/clip.json',{'provider':{'transcribed_at':'2026-09-30T20:01:25Z',
            'engine':'faster-whisper','model':'small.en','device':'cuda','compute_type':'float32'}})
        self.write(directory+'/asr/evidence.json',{'created_at':'2026-09-30T20:01:27Z'})

    def stage_events(self):
        vid=self.ids[0]
        return [('2026-09-30T20:00:00Z',vid,'preparing'),
                ('2026-09-30T20:01:00Z',vid,'transcribing'),
                ('2026-09-30T20:01:30Z',vid,'prepared')]

    def report(self,as_of='2026-09-30T20:02:00Z'):
        return PreparationTiming(self.root,'wave-one',as_of).run()

    def test_observed_combined_stages_and_qa_residual_are_correct(self):
        self.log(self.stage_events()); self.artifacts()
        result=self.report()
        metrics=result['candidates'][0]['attempts'][0]['metrics']
        self.assertEqual(metrics['preparing_to_transcribing_seconds'],60)
        self.assertEqual(metrics['active_render_pipeline_seconds'],50)
        self.assertEqual(metrics['ranged_render_seconds'],40)
        self.assertEqual(metrics['post_range_technical_qa_and_hash_seconds'],10)
        self.assertEqual(metrics['pre_render_wait_metadata_and_ledger_residual_seconds'],10)
        self.assertEqual(metrics['asr_queue_startup_decode_inference_and_hash_seconds'],25)
        self.assertEqual(metrics['asr_exit_validation_and_binding_seconds'],2)
        self.assertEqual(metrics['contact_sheet_and_ledger_seconds'],3)
        self.assertEqual(metrics['upstream_request_lifetime_union_seconds'],30)
        self.assertFalse(result['barrier']['complete'])
        self.assertEqual(result['barrier']['elapsed_observed_seconds'],120)
        self.assertEqual(result['counts'],{'prepared':1,'not_started':49})
        self.assertIn('GPU ASR semaphore queue alone',result['unmeasured'])

    def test_missing_asr_start_never_becomes_inference_time(self):
        self.log(self.stage_events()); self.artifacts()
        (self.root/'rendered'/f'{self.ids[0]}-sample/asr/clip.json').unlink()
        result=self.report()
        metrics=result['candidates'][0]['attempts'][0]['metrics']
        self.assertIsNone(metrics['asr_queue_startup_decode_inference_and_hash_seconds'])
        self.assertEqual(metrics['transcribing_to_prepared_seconds'],30)
        self.assertEqual(result['metrics']['asr_queue_startup_decode_inference_and_hash_seconds']['measured_count'],0)

    def test_cached_receipts_are_not_counted_as_fresh_render_or_asr(self):
        self.artifacts()
        vid=self.ids[0]
        self.log([('2026-09-30T20:01:40Z',vid,'preparing'),
                  ('2026-09-30T20:01:41Z',vid,'transcribing'),
                  ('2026-09-30T20:01:42Z',vid,'prepared')])
        result=self.report()
        attempt=result['candidates'][0]['attempts'][0]
        self.assertTrue(attempt['render_receipt_reused'])
        self.assertTrue(attempt['asr_receipt_reused'])
        self.assertIsNone(attempt['metrics']['active_render_pipeline_seconds'])
        self.assertIsNone(attempt['metrics']['asr_queue_startup_decode_inference_and_hash_seconds'])
        self.assertEqual(attempt['metrics']['preparing_to_prepared_seconds'],2)

    def test_duplicate_archive_logs_do_not_duplicate_attempts(self):
        self.log(self.stage_events())
        self.log(self.stage_events(),'production-attempt-2.log')
        result=self.report()
        self.assertEqual(len(result['candidates'][0]['attempts']),1)
        self.assertEqual(result['metrics']['preparing_to_prepared_seconds']['measured_count'],1)

    def test_archived_wave_uses_its_plan_status_logs_and_original_artifacts(self):
        archive=self.root/'experiments/wave-one/artifacts'
        self.write(str(archive/'experiment-plan.json'),self.plan)
        self.write(str(archive/'experiment-status.json'),{**self.status,'preparation_finished_at':'2026-09-30T20:01:40Z'})
        self.log(self.stage_events(),str(archive/'production-attempt-1.log'))
        self.write('experiment-plan.json',{'experiment_id':'wave-two'})
        self.write('experiment-status.json',{'experiment_id':'wave-two'})
        self.artifacts()
        result=self.report()
        self.assertIn('experiments',result['plan_path'])
        self.assertTrue(result['barrier']['complete'])
        self.assertEqual(result['barrier']['barrier_wall_seconds'],100)
        self.assertEqual(result['counts']['prepared'],1)

    def test_after_barrier_luna_failures_do_not_reclassify_preparation(self):
        events=self.stage_events()+[('2026-09-30T20:02:30Z',self.ids[0],'failed')]
        self.log(events)
        self.write('experiment-status.json',{**self.status,'preparation_finished_at':'2026-09-30T20:02:00Z'})
        result=self.report(as_of='2026-09-30T20:03:00Z')
        self.assertEqual(result['counts']['prepared'],1)
        self.assertNotIn('failed',result['candidates'][0]['attempts'][0]['stage_times'])

    def test_summary_and_union_do_not_add_overlaps(self):
        self.assertEqual(summary([1,2,3,4,5,None])['median_seconds'],3)
        self.assertEqual(summary([])['measured_count'],0)
        self.assertEqual(union_seconds([{'started_at':'2026-01-01T00:00:00Z','finished_at':'2026-01-01T00:00:10Z'},
            {'started_at':'2026-01-01T00:00:05Z','finished_at':'2026-01-01T00:00:15Z'}]),15)


if __name__=='__main__':
    unittest.main()
