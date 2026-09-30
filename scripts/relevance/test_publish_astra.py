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
if __name__=='__main__':unittest.main()
