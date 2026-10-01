import hashlib,json,os,subprocess,sys,tempfile,time,unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch, Mock
import publish_astra as p


def write_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,sort_keys=True,separators=(',',':')),encoding='utf-8')


@contextmanager
def held_by_child(lock_path):
    lock_path=Path(lock_path);signal=lock_path.with_suffix('.pid');stop=lock_path.with_suffix('.stop')
    code=r'''import os,sys,time
from pathlib import Path
path,signal,stop=map(Path,sys.argv[1:])
path.parent.mkdir(parents=True,exist_ok=True)
with path.open('a+b') as handle:
 handle.seek(0,2)
 if handle.tell()==0: handle.write(b'0');handle.flush()
 handle.seek(0)
 if os.name=='nt':
  import msvcrt;msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
 else:
  import fcntl;fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
 signal.write_text(str(os.getpid()))
 while not stop.exists(): time.sleep(.02)
'''
    child=subprocess.Popen([sys.executable,'-c',code,str(lock_path),str(signal),str(stop)])
    try:
        for _ in range(250):
            if signal.exists() and p.lock_is_held(lock_path):break
            if child.poll() is not None:raise RuntimeError('Owner lock child exited early')
            time.sleep(.02)
        else:raise RuntimeError('Owner lock child did not become ready')
        yield int(signal.read_text())
    finally:
        stop.touch();child.wait(timeout=5)


@contextmanager
def fixed_scope(root,selected='abcdefghijk'):
    root=Path(root);(root/'input').mkdir();(root/'publications').mkdir();authority=root/'continuation';authority.mkdir()
    outsider='zyxwvutsrqp';selected_ids=[selected]+[f'p{i:010}' for i in range(339)]
    manifest=root/'input'/'manifest.json';culls=root/'input'/'culled-ids.json'
    write_json(manifest,{'candidates':[{'candidate_id':vid} for vid in selected_ids+[outsider]]});write_json(culls,[])
    ids=authority/'selected-ids.txt';ids.write_bytes(('\n'.join(selected_ids)+'\n').encode('ascii'))
    dead=2147483647;pause='pause-fixed-owner'
    status=authority/'retired-status.json';control=authority/'retired-control.json'
    write_json(status,{'job_id':'SNIPPY-LUNA-CONTINUE-20261001','phase':'paused','desired':'paused',
        'own_children_alive':False,'runner_pid':None,'asr_pid':None,'asr_launcher_pid':None,
        'supervisor_pid':dead,'runner_status':{'active_batches':[],'active_ids':[]}})
    write_json(control,{'desired':'paused','processed_ids':[pause],'last_applied_order':['x','y',pause]})
    retirement=authority/'retirement.json';live_auth=authority/'live-revoked-authorization.json'
    live_admission=authority/'live-revoked-admission.json'
    write_json(retirement,{'retired_job_id':'SNIPPY-LUNA-CONTINUE-20261001',
        'superseded_by':'SNIPPY-SELECTED340-LUNA-20261001','supervisor_alive':False,
        'process_locks_were_free':True})
    write_json(live_auth,{'scope':'revoked','superseded_by':'SNIPPY-SELECTED340-LUNA-20261001'})
    write_json(live_admission,{'approved':False,'superseded_by':'SNIPPY-SELECTED340-LUNA-20261001'})
    auth={'schema_version':'snippy-fixed-subset-authorization-v1','job_id':'SNIPPY-SELECTED340-LUNA-20261001',
        'scope':p.FIXED_SUBSET_SCOPE,'codex_on_shadow':True,'manifest_sha256':p.sha256_file(manifest),
        'original_manifest_sha256':p.sha256_file(manifest),'culled_ids_sha256':p.sha256_file(culls),
        'selected_ids_file':ids.name,'selected_ids_sha256':p.sha256_file(ids),'candidate_count':len(selected_ids),
        'recoverable_failed_ids':[],'recovery_proofs':{},'max_batch_members':5,'batch_workers':2,
        'render_slots':2,'asr_slots':1,'publication_writers':1,'min_release_confidence':.95,'max_passes':p.MAX_PASSES,
        'broad_owner_handoff':{'job_id':'SNIPPY-LUNA-CONTINUE-20261001','status_path':str(status.resolve()),
            'status_sha256':p.sha256_file(status),'control_state_path':str(control.resolve()),
            'control_state_sha256':p.sha256_file(control),'required_pause_control_id':pause,'supervisor_pid':dead,
            'retirement_receipt_path':str(retirement.resolve()),'retirement_receipt_sha256':p.sha256_file(retirement),
            'live_authorization_path':str(live_auth.resolve()),'live_authorization_sha256':p.sha256_file(live_auth),
            'live_admission_path':str(live_admission.resolve()),'live_admission_sha256':p.sha256_file(live_admission)}}
    auth['authorization_sha256']=p.audit.digest(auth);auth_path=authority/'authorization.json';write_json(auth_path,auth)
    protected={}
    for vid in selected_ids[1:]:
        record=root/'records'/f'{vid}.json';write_json(record,{'candidate_id':vid,'status':'awaiting_astra','reason':'fixture'})
        protected[vid]=p.sha256_file(record)
    plan={'schema_version':'snippy-fixed-subset-plan-v1','continuation_id':auth['job_id'],
        'manifest_sha256':p.sha256_file(manifest),'culled_ids_sha256':p.sha256_file(culls),
        'authorization_sha256':p.sha256_file(auth_path),'selected_ids_sha256':p.sha256_file(ids),
        'authorized_candidate_ids':selected_ids,'authorized_candidate_count':len(selected_ids),'target_candidate_count':1,
        'candidate_ids':[selected],'slots':[{'candidate_ids':[selected],'execution_candidate_ids':[selected]}],
        'preflight_holds':[],'mixed_batch_inventories':[],
        'protected_record_sha256':protected,'protected_absent_ids':[outsider],
        'baseline_record_sha256':dict(protected),'preserved_file_sha256':{},
        'maximum_batch_members':5,'maximum_batch_workers':2,'render_slots':2,'asr_slots':1,
        'publication_writers':1,'min_release_confidence':.95,'max_passes':p.MAX_PASSES}
    plan['plan_sha256']=p.audit.digest(plan);plan_path=authority/'continuation-plan.json';write_json(plan_path,plan)
    owner_lock=root/'production-owner.lock'
    with held_by_child(owner_lock) as pid:
        owner={'schema_version':'snippy-production-owner-v1','job_id':auth['job_id'],'pid':pid,
            'runtime_commit':p.runtime_commit(),'continuation_authorization':{'path':str(auth_path.resolve()),'sha256':p.sha256_file(auth_path)},
            'continuation_plan':{'path':str(plan_path.resolve()),'sha256':p.sha256_file(plan_path)},
            'selected_ids_sha256':p.sha256_file(ids),'manifest_sha256':p.sha256_file(manifest),
            'culled_ids_sha256':p.sha256_file(culls),'lock_path':str(owner_lock.resolve()),
            'created_at':'2026-10-01T00:00:00Z','active':True}
        owner['owner_record_sha256']=p.audit.digest(owner);write_json(root/'production-owner.json',owner)
        yield {'selected':selected,'outsider':outsider,'authorization':auth_path,'plan':plan_path}


def valid_inputs(root,vid):
    media=root/'clip.mp4';media.write_bytes(b'test')
    recipe={'decision':'approve','clip_worthy':True,'candidate_id':vid,'title':'Title','reason':'Description',
        'edit_notes':'','speaker':'Speaker','edits':[{'start_seconds':0,'end_seconds':20,'transcript':'Speech'}]}
    qa={'passed':True,'reviewer':'independent-astra','media_sha256':hashlib.sha256(b'test').hexdigest(),
        'recipe_hash':p.audit.digest(recipe),'checks':{k:True for k in ('picture_verified','dialogue_verified','boundaries_verified','duration_verified')}}
    rp=root/'recipe.json';qp=root/'qa.json';write_json(rp,recipe);write_json(qp,qa)
    return rp,media,qp


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

    def test_fixed_scope_outsider_is_rejected_before_bigquery(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with fixed_scope(root) as scope:
                rp,media,qa=valid_inputs(root,scope['outsider'])
                with patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')) as bq:
                    with self.assertRaisesRegex(ValueError,'executable member'):
                        p.publish(rp,media,qa,root/'publications'/f"{scope['outsider']}.json",
                                  scope_plan=scope['plan'],scope_authorization=scope['authorization'])
                bq.assert_not_called()

    def test_active_fixed_owner_rejects_unscoped_publisher_before_bigquery(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with fixed_scope(root) as scope:
                rp,media,qa=valid_inputs(root,scope['selected'])
                with patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')) as bq:
                    with self.assertRaisesRegex(ValueError,'requires its exact scope'):
                        p.publish(rp,media,qa,root/'publications'/f"{scope['selected']}.json")
                bq.assert_not_called()

    def test_active_owner_authority_tamper_cannot_downgrade_to_unscoped(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with fixed_scope(root) as scope:
                rp,media,qa=valid_inputs(root,scope['selected'])
                auth=json.loads(scope['authorization'].read_text())
                auth['scope']='revoked'
                write_json(scope['authorization'],auth)
                with patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')) as bq:
                    with self.assertRaisesRegex(ValueError,'authority files|not fixed-subset'):
                        p.publish(rp,media,qa,root/'publications'/f"{scope['selected']}.json")
                bq.assert_not_called()

    def test_inactive_owner_cannot_coexist_with_held_owner_lock(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);owner_lock=root/'production-owner.lock'
            with held_by_child(owner_lock):
                owner={'schema_version':'snippy-production-owner-v1','active':False}
                owner['owner_record_sha256']=p.audit.digest(owner)
                write_json(root/'production-owner.json',owner)
                with self.assertRaisesRegex(ValueError,'Inactive production owner'):
                    p.active_fixed_owner_authority(root)

    def test_supplied_nonfixed_scope_is_rejected_before_bigquery(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);rp,media,qa=valid_inputs(root,'abcdefghijk')
            authorization=root/'authorization.json';plan=root/'plan.json'
            write_json(authorization,{'scope':'revoked'});write_json(plan,{})
            with patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')) as bq:
                with self.assertRaisesRegex(ValueError,'not fixed-subset'):
                    p.publish(rp,media,qa,root/'receipt.json',
                              scope_plan=plan,scope_authorization=authorization)
            bq.assert_not_called()

    def test_fixed_scope_raw_plan_tamper_is_rejected_before_bigquery(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with fixed_scope(root) as scope:
                rp,media,qa=valid_inputs(root,scope['selected'])
                scope['plan'].write_bytes(scope['plan'].read_bytes()+b'\n')
                with patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')) as bq:
                    with self.assertRaisesRegex(ValueError,'owner identity|authority files'):
                        p.publish(rp,media,qa,root/'publications'/f"{scope['selected']}.json",
                                  scope_plan=scope['plan'],scope_authorization=scope['authorization'])
                bq.assert_not_called()

    def test_fixed_scope_rehashed_incomplete_outsider_cover_fails_before_bigquery(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with fixed_scope(root) as scope:
                plan=p.load_json(scope['plan'])
                plan['protected_absent_ids']=[]
                plan.pop('plan_sha256')
                plan['plan_sha256']=p.audit.digest(plan)
                write_json(scope['plan'],plan)
                owner_path=root/'production-owner.json';owner=p.load_json(owner_path)
                owner['continuation_plan']['sha256']=p.sha256_file(scope['plan'])
                owner.pop('owner_record_sha256')
                owner['owner_record_sha256']=p.audit.digest(owner)
                write_json(owner_path,owner)
                rp,media,qa=valid_inputs(root,scope['selected'])
                with patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')) as bq:
                    with self.assertRaisesRegex(ValueError,'protection cover is not exact and disjoint'):
                        p.publish(rp,media,qa,root/'publications'/f"{scope['selected']}.json",
                                  scope_plan=scope['plan'],scope_authorization=scope['authorization'])
                bq.assert_not_called()

    def test_fixed_scope_rogue_record_filename_fails_before_bigquery(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with fixed_scope(root) as scope:
                rogue='rogue000000'
                write_json(root/'records'/f'{rogue}.json',{'candidate_id':rogue,'status':'published'})
                rp,media,qa=valid_inputs(root,scope['selected'])
                with patch('publish_astra.audit.bq_client',side_effect=AssertionError('Must not access database')) as bq:
                    with self.assertRaisesRegex(ValueError,'record filenames escape the frozen manifest'):
                        p.publish(rp,media,qa,root/'publications'/f"{scope['selected']}.json",
                                  scope_plan=scope['plan'],scope_authorization=scope['authorization'])
                bq.assert_not_called()

    def test_valid_fixed_scope_reaches_bigquery_only_after_owner_and_scope_checks(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with fixed_scope(root) as scope:
                rp,media,qa=valid_inputs(root,scope['selected'])
                with patch('publish_astra.audit.bq_client',side_effect=RuntimeError('scope gate passed')) as bq:
                    with self.assertRaisesRegex(RuntimeError,'scope gate passed'):
                        p.publish(rp,media,qa,root/'publications'/f"{scope['selected']}.json",
                                  scope_plan=scope['plan'],scope_authorization=scope['authorization'])
                bq.assert_called_once_with()

    def test_publication_lock_excludes_a_second_process(self):
        with tempfile.TemporaryDirectory() as d:
            lock=Path(d)/'publication.lock'
            code=("from pathlib import Path; import publish_astra as p\n"
                  "try:\n with p.publication_lock(Path(__import__('sys').argv[1])): pass\n"
                  "except p.PublicationLockBusy: raise SystemExit(17)\n")
            with p.publication_lock(lock):
                result=subprocess.run([sys.executable,'-c',code,str(lock)],cwd=Path(p.__file__).parent,
                                      capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,17,result.stdout+result.stderr)

    def test_publish_callable_acquires_lock_before_entering_guarded_body(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with p.publication_lock(root/'publication.lock'):
                with self.assertRaises(p.PublicationLockBusy):
                    p.publish(root/'missing-recipe.json',root/'missing-media.mp4',
                              root/'missing-qa.json',root/'receipt.json')

if __name__=='__main__':unittest.main()
