import copy
import unittest
import cull_media

class MediaCullTests(unittest.TestCase):
    def plan(self):
        return {'buckets':['test'],'objects':[{'bucket':'test','name':'videos/abcdefghijk.mp4','generation':'1','matched_ids':['abcdefghijk'],'inventory_state':'versions'}]}
    def test_exact_generation_plan(self):
        self.assertEqual(cull_media.validate_plan(self.plan(),['abcdefghijk']),{('test','videos/abcdefghijk.mp4','1')})
    def test_wrong_id_soft_deleted_held_duplicate_and_protected_rejected(self):
        for case in ['id','soft','hold','duplicate','protected']:
            p=self.plan();r=p['objects'][0]
            if case=='id':r['matched_ids']=['other']
            if case=='soft':r['inventory_state']='soft'
            if case=='hold':r['temporaryHold']=True
            if case=='duplicate':p['objects'].append(copy.deepcopy(r))
            if case=='protected':r['metadata']={'speaker':'Dario Amodei'}
            with self.subTest(case=case),self.assertRaises(ValueError):cull_media.validate_plan(p,['abcdefghijk'])

if __name__=='__main__':unittest.main()
