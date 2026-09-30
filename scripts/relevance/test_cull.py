import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import cull

class CullTests(unittest.TestCase):
    def manifest(self):
        return {'ids':[f'{n:011d}' for n in range(915)],'tables':[{'table_name':'youtube_videos','column_name':'video_id','archive_rows':915},{'table_name':'snippets_auto','column_name':'original_video_id','archive_rows':16}]}

    def test_transaction_gates_before_any_deletion(self):
        sql=cull.deletion_sql(self.manifest())
        self.assertTrue(sql.startswith('BEGIN TRANSACTION;'))
        self.assertTrue(sql.endswith('COMMIT TRANSACTION;'))
        self.assertLess(sql.index('archive no longer matches snippets_auto'),sql.index('DELETE FROM'))
        self.assertIn('ASSERT @@row_count=915',sql)
        self.assertIn('WHERE original_video_id IN UNNEST(@ids)',sql)
        self.assertNotIn('TRUNCATE',sql)
        self.assertNotIn('DROP',sql)

    def test_wrong_count_duplicates_and_injection_rejected(self):
        for change in ('count','duplicate','id','table','key'):
            m=self.manifest()
            if change=='count':m['ids'].pop()
            if change=='duplicate':m['ids'][1]=m['ids'][0]
            if change=='id':m['ids'][0]="unsafe'; --"
            if change=='table':m['tables'][0]['table_name']='youtube_videos`;DROP'
            if change=='key':m['tables'][0]['column_name']='title'
            with self.subTest(change=change),self.assertRaises(ValueError):cull.deletion_sql(m)

    def test_filename_fallback_and_protected_speaker_gate(self):
        with tempfile.TemporaryDirectory() as d,patch.object(cull,'OUT',Path(d)):
            p=Path(d);cull.audit.atomic(p/'manifest.json',{'ids':['abcdefghijk']})
            cull.audit.atomic(p/'vector-before.json',[{'id':'file-test','attributes':{}}])
            cull.audit.atomic(p/'vector-file-metadata.json',[{'id':'file-test','filename':'transcript_abcdefghijk_jane-doe.txt'}])
            cull.vector_plan()
            self.assertEqual(cull.read(p/'vector-plan.json')['files_to_detach'],1)
            cull.audit.atomic(p/'vector-file-metadata.json',[{'id':'file-test','filename':'transcript_abcdefghijk_sam-altman.txt'}])
            with self.assertRaises(ValueError):cull.vector_plan()

    def test_conflicting_vector_identity_rejected(self):
        with tempfile.TemporaryDirectory() as d,patch.object(cull,'OUT',Path(d)):
            p=Path(d);cull.audit.atomic(p/'manifest.json',{'ids':['abcdefghijk']})
            cull.audit.atomic(p/'vector-before.json',[{'id':'file-test','attributes':{'video_id':'other123456'}}])
            cull.audit.atomic(p/'vector-file-metadata.json',[{'id':'file-test','filename':'transcript_abcdefghijk_jane-doe.txt'}])
            with self.assertRaises(ValueError):cull.vector_plan()

    def test_no_aggregate_file_guessing(self):
        with tempfile.TemporaryDirectory() as d,patch.object(cull,'OUT',Path(d)):
            p=Path(d);cull.audit.atomic(p/'manifest.json',{'ids':['abcdefghijk']})
            cull.audit.atomic(p/'vector-before.json',[{'id':'file-test','attributes':{}}])
            cull.audit.atomic(p/'vector-file-metadata.json',[{'id':'file-test','filename':'jane-doe-transcripts.txt'}])
            with self.assertRaises(ValueError):cull.vector_plan()
            self.assertEqual(cull.read(p/'vector-plan.json')['files_to_detach'],0)

if __name__=='__main__':unittest.main()
