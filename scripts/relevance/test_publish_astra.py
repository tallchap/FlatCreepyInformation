import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch, Mock
import publish_astra as p
class PublishTests(unittest.TestCase):
    def test_exact_existing_row_is_idempotent_but_other_rows_are_held(self):
        expected={'snippet_id':'sid','original_video_id':'vid','provider':'astra','title':'Exact'}
        self.assertFalse(p.existing_publication_matches([],expected))
        self.assertTrue(p.existing_publication_matches([{**expected,'created_at':'today'}],expected))
        for rows in ([{**expected,'snippet_id':'other'}], [dict(expected),dict(expected)], [{**expected,'title':'changed'}]):
            with self.subTest(rows=rows),self.assertRaisesRegex(ValueError,'before upload'):
                p.existing_publication_matches(rows,expected)

    def test_source_duplicate_is_checked_before_any_cloud_write(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);media=root/'clip.mp4';media.write_bytes(b'test')
            recipe={'decision':'approve','clip_worthy':True,'candidate_id':'abcdefghijk','title':'Title','reason':'Description','edit_notes':'','speaker':'Speaker','edits':[{'start_seconds':0,'end_seconds':20,'transcript':'Speech'}]}
            qa={'passed':True,'reviewer':'independent-astra','media_sha256':hashlib.sha256(b'test').hexdigest(),'recipe_hash':p.audit.digest(recipe),
                'checks':{k:True for k in ('picture_verified','dialogue_verified','boundaries_verified','duration_verified')}}
            rp=root/'r.json';qp=root/'q.json';rp.write_text(json.dumps(recipe));qp.write_text(json.dumps(qa))
            def job(rows):
                value=Mock();value.result.return_value=rows;value.job_id='job';value.total_bytes_billed=0;value.cache_hit=True;return value
            client=Mock();client.query.side_effect=[job([{'n':1}]),job([]),job([{'snippet_id':'different-recipe'}])]
            with patch('publish_astra.audit.bq_client',return_value=client),patch('publish_astra.google.auth.default') as auth,patch('publish_astra.AuthorizedSession') as session:
                with self.assertRaisesRegex(ValueError,'before upload'):
                    p.publish(rp,media,qp,root/'receipt.json')
            auth.assert_not_called();session.assert_not_called()
            self.assertIn("original_video_id=@vid AND provider='astra'",client.query.call_args_list[2].args[0])

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
