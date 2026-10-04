import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import audit

class AuditTests(unittest.TestCase):
    def row(self):
        return {'video_id':'test123','input_hash':'abc','title':'Interview','publisher':'Source','speaker_source':'Jane Doe',
                'url':'https://www.youtube.com/watch?v=test123','transcript':'[0] Introduction\n[20] AI could escape our control.\n[40] We should build safeguards.',
                'plain_text':'Introduction AI could escape our control. We should build safeguards.', 'last_timestamp':60,'protected_matches':{}}

    def raw(self,**changes):
        out={'eligible':True,'original':True,'source_type':'original interview','speaker':'Jane Doe','safety_fit':'direct',
             'timeline_fit':'none','reason':'Original safety claim','vitrupo_score':7,'has_self_contained_ai_passage':True,
             'passage_reason':'Complete safety argument','best_moment':{'start_seconds':20,'end_seconds':45,
             'quote':'AI could escape our control.','claim':'Loss of control'}}
        out.update(changes)
        return {'id':'response-test','status':'completed','model':audit.MODEL,'usage':{'input_tokens':10000,'output_tokens':1000},
                'output':[{'type':'message','content':[{'type':'output_text','text':json.dumps(out)}]}]}

    def test_keep_list_exemptions_multi_speaker_and_variants(self):
        for name in audit.PROTECTED:
            with self.subTest(name=name):self.assertIn(name,audit.protected({'speaker_source':'Host, '+name}))
        self.assertIn('Yann LeCun',audit.protected({'title':'YANN LE CUN interview'}))
        self.assertIn('Geoffrey Hinton',audit.protected({'title':'Geoff Hinton on AI risk'}))
        self.assertIn('Elon Musk',audit.protected({'title':"ELON MUSK's warning on AI"}))
        self.assertFalse(audit.protected({'speaker_source':'Joao Soares'}))
        self.assertFalse(audit.protected({'speaker_source':'Kimbal Musk, Connor Stone'}))
        self.assertFalse(audit.protected({'speaker_source':'Samy Bengio, Jack Altman, Daniela Amodei'}))
        self.assertFalse(audit.protected({'transcript':'Sam Altman is mentioned'}))

    def test_protected_bypass_has_no_network_or_request(self):
        row=self.row();row['protected_matches']={'Sam Altman':['speaker_source']}
        with tempfile.TemporaryDirectory() as d,patch('audit.request_body',side_effect=AssertionError('must bypass')):
            r=audit.process(row,Path(d),'unused')
            self.assertEqual(r['status'],'preserved');self.assertFalse(r['api_called'])

    def test_missing_transcript_is_not_ineligible(self):
        row=self.row();row['transcript']=None
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(audit.process(row,Path(d),'unused')['status'],'unassessed')

    def test_eligible_evidence(self):
        r=audit.classify(self.row(),self.raw())
        self.assertEqual(r['status'],'eligible');self.assertTrue(all(r['evidence_checks'].values()))

    def test_derivative_is_separate_from_no_passage(self):
        r=audit.classify(self.row(),self.raw(eligible=False,original=False))
        self.assertEqual(r['status'],'not_eligible')
        r=audit.classify(self.row(),self.raw(eligible=False,has_self_contained_ai_passage=False,best_moment={'start_seconds':0,'end_seconds':0,'claim':'','quote':''}))
        self.assertEqual(r['status'],'no_passage')

    def test_bad_quote_or_duration_is_review_not_rejection(self):
        for m in [{'start_seconds':20,'end_seconds':45,'quote':'Invented quote','claim':'x'},
                  {'start_seconds':20,'end_seconds':25,'quote':'AI could escape our control.','claim':'x'},
                  {'start_seconds':40,'end_seconds':60,'quote':'AI could escape our control.','claim':'x'}]:
            with self.subTest(moment=m):self.assertEqual(audit.classify(self.row(),self.raw(best_moment=m))['status'],'review')

    def test_late_speaker_match_preserved(self):
        self.assertEqual(audit.classify(self.row(),self.raw(speaker='Sam Altman'))['status'],'preserved')

    def test_incomplete_or_invalid_response_fails(self):
        raw=self.raw();raw['status']='incomplete'
        with self.assertRaises(ValueError):audit.classify(self.row(),raw)
        with self.assertRaises(ValueError):audit.classify(self.row(),self.raw(vitrupo_score=99))

    def test_request_retains_full_transcript_and_hash_changes(self):
        row=self.row();body=audit.request_body(row)
        self.assertTrue(body['input'].endswith(row['transcript']))
        updated=copy.deepcopy(body);updated['input']+=' more'
        self.assertNotEqual(audit.digest(body),audit.digest(updated))

    def test_cached_raw_response_does_not_call_network(self):
        row=self.row()
        with tempfile.TemporaryDirectory() as d,patch('requests.post',side_effect=AssertionError('must use cache')):
            run=Path(d);key=audit.digest(audit.request_body(row));audit.atomic(run/'responses'/f'{key}.json',self.raw())
            self.assertEqual(audit.process(row,run,'unused')['status'],'eligible')

    def test_contradictory_negative_cannot_enter_rejection_list(self):
        with self.assertRaises(ValueError):audit.classify(self.row(),self.raw(eligible=False,has_self_contained_ai_passage=False))
        with self.assertRaises(ValueError):audit.classify(self.row(),self.raw(original=False))

    def test_cost(self):
        self.assertAlmostEqual(audit.price(self.raw()),.0015)
        raw=self.raw();raw['usage']['input_tokens_details']={'cached_tokens':1000,'cache_write_tokens':9000}
        self.assertAlmostEqual(audit.price(raw),.001635)

if __name__=='__main__':unittest.main()
