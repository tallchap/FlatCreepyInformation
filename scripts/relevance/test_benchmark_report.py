import json
from pathlib import Path
import tempfile
import unittest

import audit
from benchmark_report import BenchmarkReporter, overlap
from production_report import sha


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fresh = [f'c{i:010d}' for i in range(50)]
        self.baseline = [f'b{i:010d}' for i in range(25)]
        self.manifest = self.write('input/manifest.json', {'candidates': [{'candidate_id': vid, 'lane': 'eligible'} for vid in self.baseline + self.fresh]})
        hashes = {}
        for vid in self.baseline:
            path = self.write('records/' + vid + '.json', {'candidate_id': vid, 'status': 'already_published'})
            hashes[vid] = sha(path)
        for vid in self.fresh:
            self.write('records/' + vid + '.json', {'candidate_id': vid, 'status': 'awaiting_astra'})
        _, mac = self.response('mac-checkpoint/batches/mac', 'baseline-mac', ['b0000000000'], rid='resp_mac')
        _, shadow = self.response('batches/shadow-first', 'baseline-shadow', ['b0000000001'], rid='resp_shadow')
        self.slots = [{'batch_name': f'experiment-{i:04}', 'lane': 'eligible', 'candidate_ids': self.fresh[i*5:i*5+5]} for i in range(10)]
        self.plan = {'experiment_id': 'test-ten', 'created_at': '2026-09-30T20:00:00+00:00',
            'target_batch_count': 10, 'target_candidate_count': 50, 'candidate_ids': self.fresh,
            'baseline_covered_ids': self.baseline, 'baseline_record_sha256': hashes,
            'baseline_response_ids': ['resp_mac', 'resp_shadow'],
            'baseline_luna_cost_usd': audit.price(mac)+audit.price(shadow),
            'manifest_sha256': sha(self.manifest), 'slots': self.slots}
        self.write_plan()
        self.status = {'experiment_id': 'test-ten', 'phase': 'experiment_completed',
            'started_at': '2026-09-30T20:00:00+00:00',
            'preparation_started_at': '2026-09-30T20:00:00+00:00',
            'preparation_finished_at': '2026-09-30T20:01:00+00:00',
            'review_started_at': '2026-09-30T20:01:00+00:00',
            'review_finished_at': '2026-09-30T20:02:00+00:00',
            'finished_at': '2026-09-30T20:02:10+00:00', 'attempts': []}
        self.write('experiment-status.json', self.status)
        self.request_dirs = []
        for i, slot in enumerate(self.slots):
            directory, _ = self.response('batches/' + slot['batch_name'], str(i), slot['candidate_ids'], rid=f'resp_{i}')
            self.request_dirs.append(directory)
            self.events(directory)

    def write(self, name, value):
        path = self.root / name
        audit.atomic(path, value)
        return path

    def write_plan(self):
        self.plan.pop('plan_sha256', None)
        self.plan['plan_sha256'] = audit.digest(self.plan)
        self.write('experiment-plan.json', self.plan)

    def response(self, base, name, ids, rid):
        body = {'model': 'gpt-6-luna', 'input': name}
        directory = self.root / base / audit.digest(body)
        self.write(str(directory / 'request.json'), body)
        self.write(str(directory / 'packages.json'), [{'evidence': {'candidate_id': vid}} for vid in ids])
        raw = {'id': rid, 'model': 'gpt-6-luna', 'status': 'completed', 'usage': {'input_tokens': 100,
            'output_tokens': 20, 'input_tokens_details': {'cached_tokens': 30, 'cache_write_tokens': 20},
            'output_tokens_details': {'reasoning_tokens': 12}, 'total_tokens': 120}}
        self.write(str(directory / 'response.json'), raw)
        self.write(str(directory / 'call-state.json'), {'role': 'finalizer', 'status': 'response_saved'})
        return directory, raw

    def events(self, directory, http_status=200, error=None, start='2026-09-30T20:01:00+00:00', end='2026-09-30T20:01:10+00:00', attempt=1, append=False):
        raw = json.loads((directory/'response.json').read_text()) if (directory/'response.json').exists() else {}
        common = {'model': 'gpt-6-luna', 'role': 'finalizer', 'request_hash': directory.name,
            'started_at': start, 'attempt': attempt}
        entries = [{**common, 'event': 'request_start', 'timestamp': start},
            {**common, 'event': 'request_end', 'timestamp': end, 'ended_at': end, 'http_status': http_status,
             'response_id': raw.get('id') if http_status == 200 else None,
             'status': error or ('response_saved' if http_status == 200 else 'rate_limited')}]
        with (directory/'transport-events.jsonl').open('a' if append else 'w', encoding='utf-8') as stream:
            for entry in entries:
                stream.write(json.dumps(entry)+'\n')

    def report(self):
        return BenchmarkReporter(self.root, 'test-ten').run()

    def test_unsent_operator_cancellation_has_no_charge_or_http_interval(self):
        directory = self.request_dirs[0]
        (directory / 'response.json').unlink()
        self.write(str(directory / 'call-state.json'), {'status': 'cancelled_before_dispatch',
            'dispatched': False, 'charge_unknown': False})
        self.events(directory, http_status=None, error='cancelled_before_dispatch')
        path = directory / 'transport-events.jsonl'
        events = [json.loads(line) for line in path.read_text().splitlines()]
        events[-1].update(dispatched=False, charge_unknown=False)
        path.write_text(''.join(json.dumps(event)+'\n' for event in events), encoding='utf-8')
        report = self.report()
        self.assertEqual(report['transport']['peak_overlapping_requests'], 9)
        self.assertEqual(report['transport']['summed_http_call_seconds'], 90)
        self.assertTrue(report['checks']['current_wave_unknown_charges_and_transport_resolved'])

    def test_exact_fifty_baseline_isolation_cost_and_actual_peak(self):
        report = self.report()
        self.assertTrue(report['passed'], report['errors'])
        self.assertEqual(report['counts'], {'attempted': 50, 'pass': 0, 'deferred': 50, 'failed': 0, 'pending': 0})
        self.assertEqual(report['transport']['peak_overlapping_requests'], 10)
        self.assertEqual(report['transport']['summed_http_call_seconds'], 100)
        self.assertEqual(report['transport']['union_http_call_seconds'], 10)
        self.assertEqual(report['transport']['observed_http_span_seconds'], 10)
        self.assertEqual(report['api']['unique_responses'], 10)
        self.assertAlmostEqual(report['api']['usage_derived_cost_usd'], report['baseline']['mac_luna_cost_usd']*10)
        self.assertEqual(report['api']['token_categories']['input_tokens_details.cache_write_tokens'], 200)
        self.assertEqual(report['api']['token_categories']['output_tokens_details.reasoning_tokens'], 120)
        self.assertEqual(report['timing']['total_wall_seconds'], 130)
        self.assertEqual(report['timing']['review_repair_publication_phase_seconds'], 60)
        self.assertTrue((self.root/'benchmark-report.json').exists())
        self.assertTrue((self.root/'benchmark-report.md').exists())

    def test_half_open_overlap_does_not_count_adjacent_calls_as_concurrent(self):
        result = overlap([{'started_at': '2026-01-01T00:00:00Z', 'ended_at': '2026-01-01T00:00:10Z'},
                          {'started_at': '2026-01-01T00:00:10Z', 'ended_at': '2026-01-01T00:00:20Z'}])
        self.assertEqual(result['peak_overlapping_requests'], 1)
        self.assertEqual(result['union_http_call_seconds'], 20)

    def test_two_wave_authorization_requires_preservation_before_second_fifty(self):
        default = self.report()
        self.assertEqual(default['authorized']['wave_count'], 1)
        self.assertTrue(default['stop_contract'].startswith('STOP'))
        self.write('benchmark-context.json', {'authorized_wave_count': 2,
            'authorized_total_fresh_candidates': 100, 'authorization_updated_at': '2026-09-30T20:56:24Z'})
        report = self.report()
        self.assertEqual(report['authorized']['wave_number'], 1)
        self.assertEqual(report['authorized']['total_fresh_candidates'], 100)
        self.assertIn('preserve this first wave before the authorized second', report['stop_contract'])
        self.assertIn('STOP after wave 2', report['stop_contract'])
        markdown = (self.root/'benchmark-report.md').read_text(encoding='utf-8')
        self.assertIn('wave 1 of 2 authorized waves', markdown)
        self.assertNotIn('no additional production authorized', markdown)

    def test_mixed_seven_eligible_three_review_lanes_and_setup_are_isolated(self):
        for i, slot in enumerate(self.slots):
            lane = 'eligible' if i < 7 else 'review'
            number = i + 1 if i < 7 else i - 6
            old = self.root/'batches'/slot['batch_name']
            slot.update(lane=lane, batch_name=f'shadow-ten-20260930-{lane}-{number:04d}')
            old.rename(self.root/'batches'/slot['batch_name'])
        self.write('input/manifest.json', {'candidates': [{'candidate_id':vid,
            'lane':'review' if vid in self.fresh[35:] else 'eligible'} for vid in self.baseline+self.fresh]})
        self.plan['manifest_sha256'] = sha(self.manifest)
        self.write_plan()
        self.write('benchmark-context.json', {'relay_claimed_at':'2026-09-30T19:03:15+00:00'})
        report = self.report()
        self.assertTrue(report['passed'], report['errors'])
        self.assertEqual(report['authorized']['groups_by_lane'], {'eligible':7, 'review':3})
        self.assertEqual(report['lanes']['eligible']['candidates'],35)
        self.assertEqual(report['lanes']['review']['candidates'],15)
        self.assertEqual(report['lanes']['eligible']['http']['peak_overlapping_requests'],7)
        self.assertEqual(report['lanes']['review']['http']['peak_overlapping_requests'],3)
        self.assertAlmostEqual(report['lanes']['eligible']['usage_derived_cost_usd'],report['api']['usage_derived_cost_usd']*.7)
        self.assertAlmostEqual(report['lanes']['review']['usage_derived_cost_usd'],report['api']['usage_derived_cost_usd']*.3)
        self.assertEqual(report['setup']['setup_before_trial_seconds'],3405)
        self.assertEqual(report['timing']['total_wall_seconds'],130)

    def test_dispatch_intent_time_can_precede_real_http_start(self):
        directory = self.request_dirs[0]
        path = directory/'transport-events.jsonl'
        events = [json.loads(line) for line in path.read_text().splitlines()]
        events[0]['started_at'] = '2026-09-30T20:00:59Z'
        events[0]['start_event_is_dispatch_intent'] = True
        path.write_text(''.join(json.dumps(e)+'\n' for e in events))
        report = self.report()
        self.assertTrue(report['passed'], report['errors'])
        self.assertEqual(report['transport']['observed_http_span_seconds'], 10)

    def test_pending_failed_and_pass_are_separate(self):
        (self.root/'records'/f'{self.fresh[0]}.json').unlink()
        self.write('records/'+self.fresh[1]+'.json', {'candidate_id':self.fresh[1], 'status':'failed','stage':'luna','error':'named failure'})
        self.write('records/'+self.fresh[2]+'.json', {'candidate_id':self.fresh[2], 'status':'published'})
        report = self.report()
        self.assertEqual(report['counts'], {'attempted':49,'pass':1,'deferred':47,'failed':1,'pending':1})
        self.assertFalse(report['passed'])
        self.assertEqual(report['pending_ids'], [self.fresh[0]])

    def test_frozen_baseline_change_and_candidate_overrun_fail(self):
        self.write('records/'+self.baseline[0]+'.json', {'candidate_id':self.baseline[0],'status':'preparing'})
        self.write('records/outside0001.json', {'candidate_id':'outside0001','status':'preparing'})
        report = self.report()
        codes = [e['code'] for e in report['errors']]
        self.assertIn('baseline_record_changed', codes)
        self.assertIn('candidate_outside_authorized_fifty', codes)
        self.assertFalse(report['checks']['no_overrun'])

    def test_unknown_calls_and_retry_throttling_are_not_hidden_by_later_response(self):
        directory = self.request_dirs[0]
        self.events(directory,http_status=429)
        self.events(directory,attempt=2,start='2026-09-30T20:01:12Z',end='2026-09-30T20:01:22Z',append=True)
        other = self.request_dirs[1]
        self.events(other,http_status=500,error='unknown_charge')
        report = self.report()
        self.assertEqual(report['transport']['retry_attempts'],1)
        self.assertEqual(report['transport']['throttles_429'],1)
        self.assertEqual(len(report['transport']['unknown_or_unmatched']),1)
        self.assertTrue(report['transport']['unknown_or_unmatched'][0]['charge_unknown'])
        self.assertFalse(report['passed'])

    def test_unfinished_start_remains_flagged(self):
        directory=self.request_dirs[0]
        path=directory/'transport-events.jsonl'
        path.write_text(path.read_text().splitlines()[0]+'\n')
        report=self.report()
        self.assertTrue(report['transport']['unknown_or_unmatched'][0]['unmatched_transport_events'])
        self.assertEqual(report['transport']['closed_intervals'],9)
        self.assertFalse(report['passed'])

    def test_plan_signature_and_request_group_membership_fail_closed(self):
        self.plan['created_at']='changed'
        self.write('experiment-plan.json',self.plan)
        self.write(str(self.request_dirs[0]/'packages.json'),[{'evidence':{'candidate_id':self.fresh[10]}}])
        codes=[e['code'] for e in self.report()['errors']]
        self.assertIn('experiment_plan_signature_drift',codes)
        self.assertIn('request_outside_frozen_group',codes)

    def test_outside_request_without_response_is_overrun(self):
        directory,_=self.response('batches/unauthorized','bad',self.fresh[:5],rid='resp_bad')
        (directory/'response.json').unlink()
        report=self.report()
        self.assertFalse(report['checks']['no_overrun'])
        self.assertIn(str(directory/'request.json'),report['unauthorized_request_paths'])

    def test_gcs_bytes_exclude_baseline_and_include_selected_failures(self):
        transfer={'upstream_body_bytes_read':10,'upstream_requested_bytes':30,'conservative_response_bytes_upper_bound':20,'errors':[]}
        self.write('rendered/'+self.fresh[0]+'-sample/transfer.json',transfer)
        self.write('rendered/'+self.baseline[0]+'-baseline/transfer.json',{**transfer,'upstream_requested_bytes':999})
        report=self.report()
        self.assertEqual(report['gcs']['upstream_requested_bytes'],30)
        self.assertEqual(report['gcs']['upstream_body_bytes_read'],10)

    def test_second_wave_preserves_baseline_seventyfive_and_unresolved_charges(self):
        self.write('benchmark-context.json', {'authorized_wave_count': 2, 'authorized_total_fresh_candidates': 100})
        next_ids=[f'd{i:010d}' for i in range(50)]
        self.write('input/manifest.json',{'candidates':[{'candidate_id':vid,'lane':'eligible'}
            for vid in self.baseline+self.fresh+next_ids]})
        self.plan['manifest_sha256']=sha(self.manifest)
        self.write_plan()
        first_plan=json.loads(json.dumps(self.plan))
        archive=self.root/'experiments/test-ten'
        self.write(str(archive/'artifacts/experiment-plan.json'),first_plan)
        self.write(str(archive/'artifacts/experiment-status.json'),self.status)
        old_unknown,_=self.response('batches/experiment-0000','unknown-first-wave',self.fresh[:5],rid='unknown_not_saved')
        (old_unknown/'response.json').unlink()
        self.write(str(old_unknown/'call-state.json'),{'status':'unknown_charge'})
        preserved=[{'request_path':str(old_unknown/'request.json'),'charge_unknown':True}]
        self.write(str(archive/'archive-manifest.json'),{'first_wave_unknown_charge_evidence_preserved':preserved})
        baseline_ids=self.baseline+self.fresh
        baseline_hashes={vid:sha(self.root/'records'/f'{vid}.json') for vid in baseline_ids}
        baseline_responses=[]
        baseline_cost=0
        for base in ('batches','mac-checkpoint/batches'):
            for path in (self.root/base).glob('*/*/response.json'):
                raw=json.loads(path.read_text());baseline_responses.append(raw['id']);baseline_cost+=audit.price(raw)
        frozen_requests=[p.relative_to(self.root).as_posix() for base in ('batches','mac-checkpoint/batches')
            for p in (self.root/base).glob('*/*/request.json')]
        slots=[{'batch_name':f'wave2-eligible-{i+1:04d}','lane':'eligible','candidate_ids':next_ids[i*5:i*5+5]} for i in range(10)]
        self.plan={**first_plan,'experiment_id':'test-two','wave_number':2,'previous_experiment_id':'test-ten',
            'previous_plan_sha256':first_plan['plan_sha256'],'candidate_ids':next_ids,'slots':slots,
            'baseline_covered_ids':baseline_ids,'baseline_record_sha256':baseline_hashes,
            'baseline_response_ids':baseline_responses,'baseline_luna_cost_usd':baseline_cost,
            'baseline_request_paths':frozen_requests,
            'baseline_request_sha256':{p:sha(self.root/p) for p in frozen_requests},
            'preserved_unknown_charge_count':1,'preserved_first_wave_unknown_charges':preserved}
        self.write_plan()
        self.write('experiment-status.json',{**self.status,'experiment_id':'test-two',
            'started_at':'2026-09-30T20:03:00Z','finished_at':'2026-09-30T20:05:00Z'})
        for vid in next_ids:
            self.write('records/'+vid+'.json',{'candidate_id':vid,'status':'awaiting_astra'})
        for i,slot in enumerate(slots):
            directory,_=self.response('batches/'+slot['batch_name'],'second'+str(i),slot['candidate_ids'],rid='wave2_'+str(i))
            self.events(directory)
        report=BenchmarkReporter(self.root,'test-two').run()
        self.assertEqual(report['errors'],[])
        self.assertEqual(report['baseline']['covered_count'],75)
        self.assertTrue(report['checks']['no_overrun'])
        self.assertEqual(report['baseline']['preserved_unknown_charge_count'],1)
        self.assertFalse(report['checks']['preserved_baseline_unknowns_resolved'])
        self.assertTrue(report['checks']['current_wave_unknown_charges_and_transport_resolved'])
        self.assertFalse(report['passed'])
        self.assertEqual(report['api']['unique_responses'],10)
        self.assertAlmostEqual(report['baseline']['previous_experiments_luna_cost_usd'],report['api']['usage_derived_cost_usd'])
        self.assertAlmostEqual(report['baseline']['first_shadow_luna_cost_usd'],report['baseline']['mac_luna_cost_usd'])
        self.assertEqual(report['authorized']['wave_number'], 2)
        self.assertEqual(report['authorized']['wave_count'], 2)
        self.assertTrue(report['stop_contract'].startswith('STOP'))
        self.assertIn('Cost/time confirmation', report['stop_contract'])
        self.assertNotIn('before the authorized second', report['stop_contract'])


if __name__=='__main__':
    unittest.main()
