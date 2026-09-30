import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import publish_astra as p
class PublishTests(unittest.TestCase):
    def test_unapproved_or_stale_qa_cannot_reach_network(self):
        for case in ('reject','failed','stale','incomplete'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as d,patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')):
                root=Path(d);recipe={'decision':'approve','clip_worthy':True};media=root/'clip.mp4';media.write_bytes(b'test')
                if case=='reject':recipe['decision']='reject'
                qa={'passed':case!='failed','media_sha256':hashlib.sha256(b'test').hexdigest(),'recipe_hash':p.audit.digest(recipe),'checks':{}}
                if case=='stale':qa['media_sha256']='wrong'
                rp=root/'r.json';qp=root/'q.json';rp.write_text(json.dumps(recipe));qp.write_text(json.dumps(qa))
                with self.assertRaises(ValueError):p.publish(rp,media,qp,root/'receipt.json')
    def test_luna_release_gate_blocks_legacy_low_confidence_and_flags_before_network(self):
        import luna_batch_qa as luna
        good=luna.release_gate({'status':'approve','release_confidence':.99,'escalation_reasons':[],'preserves_meaning':True,
            'picture_status':'pass','dialogue_status':'pass','boundaries_status':'pass','metadata_status':'pass'})
        self.assertTrue(luna.release_gate_passed(good))
        for gate in (None, {**good,'passed':False}, {**good,'release_confidence':.94},
                     {**good,'escalation_reasons':['boundary_uncertain']}):
            with self.subTest(gate=gate),tempfile.TemporaryDirectory() as d,patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')):
                root=Path(d);recipe={'decision':'approve','clip_worthy':True,'candidate_id':'abcdefghijk'}
                media=root/'clip.mp4';media.write_bytes(b'test')
                qa={'passed':True,'reviewer':'gpt-6-luna','release_gate':gate,
                    'media_sha256':hashlib.sha256(b'test').hexdigest(),'recipe_hash':p.audit.digest(recipe),
                    'checks':{k:True for k in ('picture_verified','dialogue_verified','boundaries_verified','duration_verified')}}
                rp=root/'r.json';qp=root/'q.json';rp.write_text(json.dumps(recipe));qp.write_text(json.dumps(qa))
                with self.assertRaisesRegex(ValueError,'confidence gate'):p.publish(rp,media,qp,root/'receipt.json')

    def test_valid_luna_gate_reaches_publication_checks(self):
        import luna_batch_qa as luna
        gate=luna.release_gate({'status':'approve','preserves_meaning':True,'release_confidence':.99,'escalation_reasons':[],
            'picture_status':'pass','dialogue_status':'pass','boundaries_status':'pass','metadata_status':'pass'})
        with tempfile.TemporaryDirectory() as d,patch('publish_astra.audit.bq_client',side_effect=RuntimeError('Reached live library validation')):
            root=Path(d);recipe={'decision':'approve','clip_worthy':True,'candidate_id':'abcdefghijk'}
            media=root/'clip.mp4';media.write_bytes(b'test')
            qa={'passed':True,'reviewer':'gpt-6-luna','release_gate':gate,
                'media_sha256':hashlib.sha256(b'test').hexdigest(),'recipe_hash':p.audit.digest(recipe),
                'checks':{k:True for k in ('picture_verified','dialogue_verified','boundaries_verified','duration_verified')}}
            rp=root/'r.json';qp=root/'q.json';rp.write_text(json.dumps(recipe));qp.write_text(json.dumps(qa))
            with self.assertRaisesRegex(RuntimeError,'Reached live library validation'):p.publish(rp,media,qp,root/'receipt.json')

if __name__=='__main__':unittest.main()
