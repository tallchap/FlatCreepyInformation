#!/usr/bin/env python3
"""Publish a verified Astra clip once; original source media remains untouched."""
import argparse,base64,hashlib,json,os,re,subprocess
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote
import google.auth
from google.auth.transport.requests import AuthorizedSession
from google.cloud import bigquery
import requests
import audit
from luna_batch_qa import MAX_PASSES,release_gate_passed

TABLE='youtubetranscripts-429803.reptranscripts.snippets_auto'
BUCKET='snippysaurus-clips'
FIXED_SUBSET_SCOPE='fixed_subset_frozen_manifest'
FIXED_SUBSET_EXPECTED_COUNT=340


class PublicationLockBusy(RuntimeError):
    """Another process owns the one publication critical section."""


def sha256_file(path):
    value=hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024*1024),b''):
            value.update(chunk)
    return value.hexdigest()


@contextmanager
def publication_lock(path):
    """Hold the one nonblocking publication lock across validation and readback."""
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a+b') as handle:
        handle.seek(0,2)
        if handle.tell()==0:
            handle.write(b'0');handle.flush()
        handle.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as exc:
            raise PublicationLockBusy('Another process owns the publication critical section') from exc
        try:
            yield
        finally:
            handle.seek(0)
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
            else:
                import fcntl
                fcntl.flock(handle,fcntl.LOCK_UN)


def process_alive(pid):
    if type(pid) is not int or pid<=0:return False
    if os.name=='nt':
        import ctypes
        handle=ctypes.windll.kernel32.OpenProcess(0x1000,False,pid)
        if not handle:return False
        ctypes.windll.kernel32.CloseHandle(handle);return True
    try:os.kill(pid,0);return True
    except OSError:return False


def lock_is_held(path):
    """Probe an existing owner lock without ever taking ownership of it."""
    path=Path(path)
    if not path.is_file():return False
    with path.open('r+b') as handle:
        handle.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as exc:
            if getattr(exc,'errno',None) not in (11,13):raise
            return True
        handle.seek(0)
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            fcntl.flock(handle,fcntl.LOCK_UN)
        return False


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def self_hash_valid(value,field):
    unsigned={key:item for key,item in value.items() if key!=field}
    return value.get(field)==audit.digest(unsigned)


def load_lf_ids(path,expected_sha256):
    path=Path(path);raw=path.read_bytes()
    if sha256_file(path)!=expected_sha256:
        raise ValueError('Fixed subset ID file raw hash changed')
    if not raw or raw.startswith(b'\xef\xbb\xbf') or b'\r' in raw or not raw.endswith(b'\n'):
        raise ValueError('Fixed subset ID file must be BOM-free, LF-only, and newline terminated')
    try:ids=raw[:-1].decode('ascii').split('\n')
    except UnicodeDecodeError as exc:raise ValueError('Fixed subset IDs must be ASCII') from exc
    if any(not re.fullmatch(r'[A-Za-z0-9_-]{11}',vid) for vid in ids) or len(ids)!=len(set(ids)):
        raise ValueError('Fixed subset IDs are invalid or duplicated')
    return ids


def runtime_commit():
    repo=Path(__file__).resolve().parents[2]
    result=subprocess.run(['git','rev-parse','HEAD'],cwd=repo,text=True,capture_output=True,check=True)
    commit=result.stdout.strip()
    if not re.fullmatch(r'[0-9a-f]{40}',commit):raise ValueError('Runtime commit is not canonical')
    return commit


def validate_retired_broad_owner(authorization):
    handoff=authorization.get('broad_owner_handoff',{})
    status_path=Path(handoff.get('status_path',''));control_path=Path(handoff.get('control_state_path',''))
    retirement_path=Path(handoff.get('retirement_receipt_path',''))
    live_authorization_path=Path(handoff.get('live_authorization_path',''))
    live_admission_path=Path(handoff.get('live_admission_path',''))
    if (handoff.get('job_id')!='SNIPPY-LUNA-CONTINUE-20261001'
            or not all(path.is_absolute() and path.is_file() for path in
                       (status_path,control_path,retirement_path,live_authorization_path,live_admission_path))
            or sha256_file(status_path)!=handoff.get('status_sha256')
            or sha256_file(control_path)!=handoff.get('control_state_sha256')
            or sha256_file(retirement_path)!=handoff.get('retirement_receipt_sha256')
            or sha256_file(live_authorization_path)!=handoff.get('live_authorization_sha256')
            or sha256_file(live_admission_path)!=handoff.get('live_admission_sha256')):
        raise ValueError('Broad-owner handoff identity or frozen evidence changed')
    status,control=load_json(status_path),load_json(control_path)
    retirement=load_json(retirement_path);live_authorization=load_json(live_authorization_path)
    live_admission=load_json(live_admission_path)
    runner_status=status.get('runner_status') or {};required=handoff.get('required_pause_control_id')
    last_order=control.get('last_applied_order')
    if (status.get('job_id')!=handoff['job_id'] or status.get('phase')!='paused'
            or status.get('desired')!='paused' or status.get('own_children_alive') is not False
            or any(status.get(key) is not None for key in ('runner_pid','asr_pid','asr_launcher_pid'))
            or runner_status.get('active_batches') not in (None,[])
            or runner_status.get('active_ids') not in (None,[])
            or control.get('desired')!='paused' or required not in control.get('processed_ids',[])
            or not isinstance(last_order,list) or not last_order or last_order[-1]!=required
            or status.get('supervisor_pid')!=handoff.get('supervisor_pid')
            or process_alive(handoff.get('supervisor_pid'))
            or retirement.get('retired_job_id')!=handoff['job_id']
            or retirement.get('superseded_by')!=authorization.get('job_id')
            or retirement.get('supervisor_alive') is not False
            or retirement.get('process_locks_were_free') is not True
            or live_authorization.get('scope')!='revoked'
            or live_authorization.get('superseded_by')!=authorization.get('job_id')
            or live_admission.get('approved') is not False
            or live_admission.get('superseded_by')!=authorization.get('job_id')):
        raise ValueError('Broad owner is not immutably paused, drained, and retired')


def validate_fixed_scope(vid,out,plan_path,authorization_path):
    """Fail closed on every immutable scope/owner identity before cloud access."""
    plan_path=Path(plan_path).resolve();authorization_path=Path(authorization_path).resolve();out=Path(out).resolve()
    if not plan_path.is_file() or not authorization_path.is_file():
        raise ValueError('Fixed subset plan and authorization must exist')
    authorization=load_json(authorization_path);plan=load_json(plan_path)
    if (authorization.get('schema_version')!='snippy-fixed-subset-authorization-v1'
            or authorization.get('scope')!=FIXED_SUBSET_SCOPE
            or authorization.get('codex_on_shadow') is not True
            or not re.fullmatch(r'[A-Z0-9][A-Z0-9_-]{0,79}',str(authorization.get('job_id','')))
            or not self_hash_valid(authorization,'authorization_sha256')):
        raise ValueError('Fixed subset authorization identity or self-hash is invalid')
    auth_raw_sha=sha256_file(authorization_path)
    selected_relative=authorization.get('selected_ids_file')
    if (not isinstance(selected_relative,str) or Path(selected_relative).is_absolute()
            or not re.fullmatch(r'[A-Za-z0-9_.-]+',selected_relative)):
        raise ValueError('Fixed subset ID path is invalid')
    ids_path=(authorization_path.parent/selected_relative).resolve()
    if not ids_path.is_relative_to(authorization_path.parent):raise ValueError('Fixed subset ID path escaped authority directory')
    selected=load_lf_ids(ids_path,authorization.get('selected_ids_sha256'))
    if (authorization.get('candidate_count')!=len(selected) or len(selected)!=FIXED_SUBSET_EXPECTED_COUNT
            or authorization.get('recoverable_failed_ids',[]) or authorization.get('recovery_proofs',{})
            or authorization.get('max_batch_members')!=5 or authorization.get('batch_workers')!=2
            or authorization.get('render_slots')!=2 or authorization.get('asr_slots')!=1
            or authorization.get('publication_writers')!=1 or authorization.get('min_release_confidence')!=.95
            or authorization.get('max_passes')!=MAX_PASSES):
        raise ValueError('Fixed subset authorization count or policy changed')
    root=out.parent.parent
    if out.parent.name!='publications' or out.name!=f'{vid}.json':
        raise ValueError('Fixed subset receipt must use the scoped root publications path')
    manifest_path=root/'input'/'manifest.json';cull_path=root/'input'/'culled-ids.json'
    manifest_sha=sha256_file(manifest_path);cull_sha=sha256_file(cull_path)
    if (authorization.get('manifest_sha256')!=manifest_sha
            or authorization.get('original_manifest_sha256')!=manifest_sha
            or authorization.get('culled_ids_sha256')!=cull_sha):
        raise ValueError('Fixed subset manifest or cull hash changed')
    manifest_ids={row['candidate_id'] for row in load_json(manifest_path)['candidates']}
    culled={row['video_id'] if isinstance(row,dict) else row for row in load_json(cull_path)}
    if set(selected)-manifest_ids or set(selected)&culled:raise ValueError('Fixed subset manifest membership or cull exclusion failed')
    unsigned_plan={key:value for key,value in plan.items() if key!='plan_sha256'}
    if (plan.get('schema_version')!='snippy-fixed-subset-plan-v1'
            or plan.get('continuation_id')!=authorization['job_id']
            or plan.get('authorization_sha256')!=auth_raw_sha
            or plan.get('manifest_sha256')!=manifest_sha or plan.get('culled_ids_sha256')!=cull_sha
            or plan.get('selected_ids_sha256')!=authorization['selected_ids_sha256']
            or plan.get('authorized_candidate_ids')!=selected
            or plan.get('authorized_candidate_count')!=len(selected)
            or plan.get('maximum_batch_members')!=5 or plan.get('maximum_batch_workers')!=2
            or plan.get('render_slots')!=2 or plan.get('asr_slots')!=1 or plan.get('publication_writers')!=1
            or plan.get('min_release_confidence')!=.95 or plan.get('max_passes')!=MAX_PASSES
            or plan.get('plan_sha256')!=audit.digest(unsigned_plan)):
        raise ValueError('Fixed subset plan identity, raw hashes, or self-hash changed')
    selected_set=set(selected)
    protected=plan.get('protected_record_sha256')
    absent_rows=plan.get('protected_absent_ids')
    if not isinstance(protected,dict) or not isinstance(absent_rows,list):
        raise ValueError('Fixed-subset outsider protection inventories are malformed')
    if any(not isinstance(candidate_id,str) for candidate_id in [*protected,*absent_rows]):
        raise ValueError('Fixed-subset outsider protection inventories are duplicated or invalid')
    if (len(absent_rows)!=len(set(absent_rows))
            or any(not isinstance(expected,str) or not re.fullmatch(r'[0-9a-f]{64}',expected)
                   for expected in protected.values())):
        raise ValueError('Fixed-subset outsider protection inventories are duplicated or invalid')
    protected_ids=set(protected);protected_outside=protected_ids-selected_set;absent=set(absent_rows)
    outsiders=manifest_ids-selected_set
    if (protected_ids-manifest_ids or absent-manifest_ids or absent&selected_set
            or protected_outside&absent or protected_outside|absent!=outsiders):
        raise ValueError('Fixed-subset outsider protection cover is not exact and disjoint')
    current_record_ids={record.stem for record in (root/'records').glob('*.json')}
    outside_manifest=current_record_ids-manifest_ids
    if outside_manifest:
        raise ValueError('Ledger record filenames escape the frozen manifest: '
                         +','.join(sorted(outside_manifest)[:10]))
    unauthorized=current_record_ids-selected_set-protected_outside
    if unauthorized:
        raise ValueError('Ledger records are neither selected nor protected existing outsiders: '
                         +','.join(sorted(unauthorized)[:10]))
    missing=protected_outside-current_record_ids
    if missing:
        raise ValueError('Protected existing outsider records disappeared: '
                         +','.join(sorted(missing)[:10]))
    appeared=current_record_ids&absent
    if appeared:
        raise ValueError('Protected absent outsider records appeared: '
                         +','.join(sorted(appeared)[:10]))
    execution=[]
    for slot in plan.get('slots',[]):
        slot_ids=slot.get('candidate_ids',[]);run_ids=slot.get('execution_candidate_ids',[])
        if not 1<=len(slot_ids)<=5 or len(run_ids)!=len(set(run_ids)) or not set(run_ids)<=set(slot_ids)<=set(selected):
            raise ValueError('Fixed subset execution slot membership is invalid')
        execution.extend(run_ids)
    held=[row.get('candidate_id') for row in plan.get('preflight_holds',[])]
    candidates=plan.get('candidate_ids',[])
    if (len(execution+held)!=len(set(execution+held)) or set(execution+held)!=set(candidates)
            or not set(candidates)<=set(selected) or vid not in execution):
        raise ValueError('Candidate is not an executable member of the fixed subset plan')
    for candidate_id,expected in plan.get('protected_record_sha256',{}).items():
        record=root/'records'/f'{candidate_id}.json'
        if not record.is_file() or sha256_file(record)!=expected:
            raise ValueError('Protected prior disposition changed before publication: '+candidate_id)
    for candidate_id in plan.get('protected_absent_ids',[]):
        if (root/'records'/f'{candidate_id}.json').exists():
            raise ValueError('Out-of-scope record appeared before publication: '+candidate_id)
    for relative,expected in plan.get('preserved_file_sha256',{}).items():
        source=(root/relative).resolve()
        if not source.is_relative_to(root) or not source.is_file() or sha256_file(source)!=expected:
            raise ValueError('Prior checkpoint or paid batch plan changed before publication: '+relative)
    validate_retired_broad_owner(authorization)
    owner_path=root/'production-owner.json';owner_lock=root/'production-owner.lock'
    if not owner_path.is_file():raise ValueError('Live production owner record is missing')
    owner=load_json(owner_path)
    if (owner.get('schema_version')!='snippy-production-owner-v1'
            or not self_hash_valid(owner,'owner_record_sha256')
            or owner.get('active') is not True
            or owner.get('job_id')!=authorization['job_id']
            or owner.get('pid')==os.getpid() or not process_alive(owner.get('pid'))
            or owner.get('runtime_commit')!=runtime_commit()
            or owner.get('continuation_authorization')!={'path':str(authorization_path),'sha256':auth_raw_sha}
            or owner.get('continuation_plan')!={'path':str(plan_path),'sha256':sha256_file(plan_path)}
            or owner.get('selected_ids_sha256')!=authorization['selected_ids_sha256']
            or owner.get('manifest_sha256')!=manifest_sha or owner.get('culled_ids_sha256')!=cull_sha
            or owner.get('lock_path')!=str(owner_lock.resolve()) or not owner.get('created_at')):
        raise ValueError('Live production owner identity does not match fixed scope')
    owner_raw=owner_path.read_bytes()
    if not lock_is_held(owner_lock) or owner_path.read_bytes()!=owner_raw or not process_alive(owner['pid']):
        raise ValueError('Production owner lock is not continuously held by the live recorded owner')
    return root


def existing_publication_matches(rows, expected):
    """Permit exact idempotent replay; hold alternate/duplicate source rows."""
    if not rows:
        return False
    if len(rows) != 1 or any(rows[0].get(key) != value for key, value in expected.items()):
        raise ValueError('Existing Astra publication for source differs or is duplicated; reconciliation required before upload')
    return True


def active_fixed_owner_authority(root):
    """Return the exact fixed authority paths when a scoped owner is active."""
    root=Path(root).resolve();owner_path=root/'production-owner.json'
    if not owner_path.is_file():return None
    owner=load_json(owner_path)
    if owner.get('active') is not True:
        if lock_is_held(root/'production-owner.lock'):
            raise ValueError('Inactive production owner cannot coexist with a held owner lock')
        return None
    unsigned={key:value for key,value in owner.items() if key!='owner_record_sha256'}
    if (owner.get('schema_version')!='snippy-production-owner-v1'
            or owner.get('owner_record_sha256')!=audit.digest(unsigned)):
        raise ValueError('Active production owner record has an unknown schema')
    reference=owner.get('continuation_authorization')
    plan_reference=owner.get('continuation_plan')
    if not isinstance(reference,dict) or not isinstance(plan_reference,dict):
        raise ValueError('Active production owner authority binding is missing')
    authorization_path=Path(reference.get('path','')).resolve()
    plan_path=Path(plan_reference.get('path','')).resolve()
    if (not authorization_path.is_file() or not plan_path.is_file()
            or reference.get('sha256')!=sha256_file(authorization_path)
            or plan_reference.get('sha256')!=sha256_file(plan_path)
            or owner.get('lock_path')!=str((root/'production-owner.lock').resolve())
            or not process_alive(owner.get('pid')) or not lock_is_held(root/'production-owner.lock')):
        raise ValueError('Active production owner authority files are missing')
    authorization=load_json(authorization_path)
    if authorization.get('scope')!=FIXED_SUBSET_SCOPE:
        raise ValueError('Active scoped production owner authorization is not fixed-subset authority')
    return authorization_path,plan_path


def _publish(recipe_path,media_path,qa_path,out,min_release_confidence=0.95,scope_plan=None,scope_authorization=None):
    recipe=json.loads(recipe_path.read_text());qa=json.loads(qa_path.read_text())
    if recipe['decision'] not in ('approve','revise') or not recipe['clip_worthy']:raise ValueError('Not approved')
    if bool(scope_plan)!=bool(scope_authorization):raise ValueError('Scope plan and authorization must be supplied together')
    root=out.parent.parent if out.parent.name=='publications' else out.parent
    active_scope=active_fixed_owner_authority(root)
    if active_scope:
        if not scope_plan or (Path(scope_authorization).resolve(),Path(scope_plan).resolve())!=active_scope:
            raise ValueError('Active fixed-subset owner requires its exact scope authorization and plan')
    if scope_authorization:
        authorization=load_json(scope_authorization)
        if authorization.get('scope')!=FIXED_SUBSET_SCOPE:
            raise ValueError('Supplied publication scope is not fixed-subset authority')
        if authorization.get('scope')==FIXED_SUBSET_SCOPE:
            validate_fixed_scope(recipe['candidate_id'],out,scope_plan,scope_authorization)
    sha=hashlib.sha256(media_path.read_bytes()).hexdigest();rh=audit.digest(recipe)
    if not qa.get('passed') or qa.get('media_sha256')!=sha or qa.get('recipe_hash')!=rh:raise ValueError('QA is absent, failed, or stale')
    required=['picture_verified','dialogue_verified','boundaries_verified','duration_verified']
    if not all(qa.get('checks',{}).get(k) is True for k in required):raise ValueError('Incomplete audiovisual QA')
    if str(qa.get('reviewer','')).startswith('gpt-6-luna') and not release_gate_passed(qa.get('release_gate'), min_release_confidence):
        raise ValueError('Luna confidence gate missing or failed; fresh Luna/Astra QA required')
    vid=recipe['candidate_id'];sid='astra_'+vid+'_'+rh[:12];name=f'clips/astra/{vid}/{rh[:16]}.mp4'
    b=audit.bq_client();jobs=[]
    attempt_path=out.parent.parent/'publication-attempts'/f'{vid}.json'
    public=f'https://storage.googleapis.com/{BUCKET}/{name}'
    row={'snippet_id':sid,'original_video_id':vid,'title':recipe['title'],'description':recipe['reason']+' '+recipe['edit_notes'],'category':'ai_safety','duration_ms':round(sum(e['end_seconds']-e['start_seconds'] for e in recipe['edits'])*1000),'transcript':' '.join(e['transcript'] for e in recipe['edits']),'gcs_url':public,'provider':'astra','speaker':recipe['speaker']}
    def query(sql, **kwargs):
        job=b.query(sql, **kwargs)
        try:
            rows=list(job.result())
        finally:
            jobs.append({'job_id':job.job_id,'bytes_billed':job.total_bytes_billed or 0,'cache_hit':job.cache_hit})
            audit.atomic(attempt_path,{'time':audit.now(),'candidate_id':vid,'snippet_id':sid,'recipe_hash':rh,'media_sha256':sha,'status':'in_progress','query_jobs':jobs})
        return rows
    params=[bigquery.ScalarQueryParameter('vid','STRING',vid)]
    live=query('SELECT COUNT(*) n FROM `youtubetranscripts-429803.reptranscripts.youtube_videos` WHERE video_id=@vid',job_config=bigquery.QueryJobConfig(query_parameters=params))[0]['n']
    if not live:raise ValueError('Source not in live library')
    cull_ids={r['video_id'] for r in query('SELECT video_id FROM `youtubetranscripts-429803.snippy_history.cull_20260930_decisions`')}
    if vid in cull_ids:raise ValueError('Culled source forbidden')
    # Recheck immediately before cloud writes, not only once at runner startup.
    # The owning Relay worker remains the single writer: BigQuery has no unique
    # source constraint that could replace that contract for unrelated writers.
    existing=[dict(r) for r in query(f"SELECT * FROM `{TABLE}` WHERE original_video_id=@vid AND provider='astra'",job_config=bigquery.QueryJobConfig(query_parameters=params))]
    existing_publication_matches(existing,row)
    s=AuthorizedSession(google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])[0]);url='https://storage.googleapis.com/storage/v1/b/'+BUCKET+'/o/'+quote(name,safe='')
    meta=s.get(url,timeout=30)
    md5=base64.b64encode(hashlib.md5(media_path.read_bytes()).digest()).decode()
    if meta.status_code==404:
        with media_path.open('rb') as f:r=s.post(f'https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o',params={'uploadType':'media','name':name,'ifGenerationMatch':'0'},headers={'Content-Type':'video/mp4'},data=f,timeout=180)
        r.raise_for_status()
        meta=s.get(url,timeout=30)
    meta.raise_for_status();stored=meta.json()
    if stored.get('md5Hash')!=md5 or int(stored['size'])!=media_path.stat().st_size:raise ValueError('Uploaded bytes mismatch')
    response=requests.get(public,headers={'Range':'bytes=0-31'},timeout=30);response.raise_for_status()
    if response.status_code!=206 or response.content!=media_path.read_bytes()[:32]:raise ValueError('Public playback range verification failed')
    params=[bigquery.ScalarQueryParameter(k,'INT64' if k=='duration_ms' else 'STRING',v) for k,v in row.items()]
    cols=', '.join(row);vals=', '.join('@'+k for k in row)
    sql=f'MERGE `{TABLE}` T USING (SELECT @snippet_id snippet_id) S ON T.snippet_id=S.snippet_id WHEN NOT MATCHED THEN INSERT ({cols},created_at) VALUES ({vals},CURRENT_TIMESTAMP())'
    query(sql,job_config=bigquery.QueryJobConfig(query_parameters=params))
    rows=[dict(r) for r in query(f"SELECT * FROM `{TABLE}` WHERE original_video_id=@vid AND provider='astra'",job_config=bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter('vid','STRING',vid)]))]
    if len(rows)!=1 or any(rows[0][k]!=v for k,v in row.items()):raise ValueError('DB receipt mismatch or duplicate')
    receipt={'passed':True,'time':audit.now(),'snippet_id':sid,'video_id':vid,'gcs_url':public,'gcs_generation':stored['generation'],'media_sha256':sha,'recipe_hash':rh,'uploaded_bytes':media_path.stat().st_size,'row':{k:str(v) for k,v in rows[0].items()},'query_jobs':jobs,'query_bytes_billed':sum(j['bytes_billed'] for j in jobs)}
    audit.atomic(out,receipt);print(json.dumps(receipt,indent=2))
    audit.atomic(attempt_path,{'time':audit.now(),'candidate_id':vid,'status':'verified','receipt':str(out),'query_jobs':jobs})


def publish(recipe_path,media_path,qa_path,out,min_release_confidence=0.95,scope_plan=None,scope_authorization=None):
    recipe_path,media_path,qa_path,out=map(Path,(recipe_path,media_path,qa_path,out))
    # Real production receipts live at root/publications/<id>.json. Legacy/test
    # callers retain their existing directory while still getting an OS lock.
    root=out.parent.parent if out.parent.name=='publications' else out.parent
    with publication_lock(root/'publication.lock'):
        return _publish(recipe_path,media_path,qa_path,out,min_release_confidence,scope_plan,scope_authorization)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--recipe',type=Path,required=True);p.add_argument('--media',type=Path,required=True);p.add_argument('--qa',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--min-release-confidence',type=float,default=0.95);p.add_argument('--scope-plan',type=Path);p.add_argument('--scope-authorization',type=Path);a=p.parse_args();publish(a.recipe,a.media,a.qa,a.out,a.min_release_confidence,a.scope_plan,a.scope_authorization)
