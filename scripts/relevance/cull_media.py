#!/usr/bin/env python3
"""Permanently delete only reviewed GCS media generations after text archival."""
import concurrent.futures
import hashlib
import json
import threading
import time
from urllib.parse import quote
import google.auth
from google.auth.transport.requests import AuthorizedSession
import cull

BASE='https://storage.googleapis.com/storage/v1'

def session():
    return AuthorizedSession(google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])[0])

def validate_plan(plan, ids):
    seen=set()
    for row in plan['objects']:
        identity=(row['bucket'],row['name'],row['generation'])
        if identity in seen:raise ValueError('Duplicate object generation')
        seen.add(identity)
        if not row.get('matched_ids') or not set(row['matched_ids'])<=set(ids):raise ValueError('Unapproved object identity')
        if row['inventory_state']!='versions':raise ValueError('Existing soft-deleted media cannot be purged early')
        if row.get('temporaryHold') or row.get('eventBasedHold') or row.get('retention'):raise ValueError('Object retention/hold must be investigated')
        if cull.audit.protected({'title':row['name'],'speaker_source':json.dumps(row.get('metadata',{}))}):raise ValueError('Protected speaker conflict')
    if sorted({r['bucket'] for r in plan['objects']})!=plan['buckets']:raise ValueError('Bucket plan differs')
    return seen

def delete():
    out=cull.OUT;plan=cull.read(out/'gcs-delete-plan.json');_,ids=cull.approved();validate_plan(plan,ids)
    for name in ['archive-verification.json','local-verification.json']:
        if not cull.read(out/name)['passed']:raise ValueError('Text archive unverified')
    for path,h in cull.read(out/'local-verification.json')['files_sha256'].items():
        if hashlib.sha256((out/path).read_bytes()).hexdigest()!=h:raise ValueError('Archive checksum failed')
    s=session();receipts=out/'gcs-delete-receipts';receipts.mkdir(exist_ok=True)
    for bucket in plan['buckets']:
        bucket_url=BASE+'/b/'+quote(bucket,safe='');r=s.get(bucket_url,timeout=30);r.raise_for_status();original=r.json()
        config_path=out/f'gcs-policy-original-{bucket}.json'
        if not config_path.exists():cull.audit.atomic(config_path,original)
        original=cull.read(config_path)
        duration=original.get('softDeletePolicy',{}).get('retentionDurationSeconds','0')
        changed=False
        try:
            current=s.get(bucket_url,timeout=30);current.raise_for_status();current=current.json()
            if current.get('retentionPolicy'):raise ValueError('Bucket retention policy must be investigated')
            r=s.patch(bucket_url,params={'ifMetagenerationMatch':current['metageneration']},json={'softDeletePolicy':{'retentionDurationSeconds':'0'}},timeout=30);r.raise_for_status();changed=True
            cull.audit.atomic(out/f'gcs-policy-disabled-{bucket}.json',r.json())
            print('Soft delete disabled; waiting for documented 30-second propagation',flush=True);time.sleep(35)
            check=s.get(bucket_url,timeout=30);check.raise_for_status()
            if int(check.json().get('softDeletePolicy',{}).get('retentionDurationSeconds',0))!=0:raise ValueError('Soft delete is still enabled')
            rows=[r for r in plan['objects'] if r['bucket']==bucket];local=threading.local()
            def one(row):
                key=cull.audit.digest([bucket,row['name'],row['generation']]);path=receipts/(key+'.json')
                if path.exists() and cull.read(path)['deleted']:return
                if not hasattr(local,'s'):local.s=session()
                url=bucket_url+'/o/'+quote(row['name'],safe='')
                for attempt in range(5):
                    response=local.s.delete(url,params={'generation':row['generation'],'ifGenerationMatch':row['generation']},timeout=60)
                    if response.status_code in (204,404):
                        cull.audit.atomic(path,{'time':cull.audit.now(),'bucket':bucket,'name':row['name'],'generation':row['generation'],'bytes':int(row['size']),'matched_ids':row['matched_ids'],'deleted':True,'http_status':response.status_code,'soft_delete_disabled':True});return
                    if response.status_code in (429,500,502,503,504):time.sleep(2**attempt);continue
                    response.raise_for_status()
                raise RuntimeError('Deletion retries exhausted')
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                for i,_ in enumerate(pool.map(one,rows),1):
                    if i%100==0:print('Permanently deleted',i,'/',len(rows),flush=True)
        finally:
            if changed:
                latest=s.get(bucket_url,timeout=30);latest.raise_for_status()
                restore=s.patch(bucket_url,params={'ifMetagenerationMatch':latest.json()['metageneration']},json={'softDeletePolicy':{'retentionDurationSeconds':duration}},timeout=30);restore.raise_for_status()
                cull.audit.atomic(out/f'gcs-policy-restored-{bucket}.json',restore.json())
                if str(restore.json().get('softDeletePolicy',{}).get('retentionDurationSeconds','0'))!=str(duration):raise ValueError('Bucket policy restoration failed')
                print('Normal bucket policy restored',flush=True)
    print('Media deletion complete',len(plan['objects']),flush=True)

if __name__=='__main__':delete()
