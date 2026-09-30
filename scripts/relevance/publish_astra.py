#!/usr/bin/env python3
"""Publish a verified Astra clip once; original source media remains untouched."""
import argparse,base64,hashlib,json
from pathlib import Path
from urllib.parse import quote
import google.auth
from google.auth.transport.requests import AuthorizedSession
from google.cloud import bigquery
import requests
import audit

TABLE='youtubetranscripts-429803.reptranscripts.snippets_auto'
BUCKET='snippysaurus-clips'

def publish(recipe_path,media_path,qa_path,out):
    recipe=json.loads(recipe_path.read_text());qa=json.loads(qa_path.read_text())
    if recipe['decision'] not in ('approve','revise') or not recipe['clip_worthy']:raise ValueError('Not approved')
    sha=hashlib.sha256(media_path.read_bytes()).hexdigest();rh=audit.digest(recipe)
    if not qa.get('passed') or qa.get('media_sha256')!=sha or qa.get('recipe_hash')!=rh:raise ValueError('QA is absent, failed, or stale')
    required=['picture_verified','dialogue_verified','boundaries_verified','duration_verified']
    if not all(qa.get('checks',{}).get(k) is True for k in required):raise ValueError('Incomplete audiovisual QA')
    vid=recipe['candidate_id'];sid='astra_'+vid+'_'+rh[:12];name=f'clips/astra/{vid}/{rh[:16]}.mp4'
    b=audit.bq_client();params=[bigquery.ScalarQueryParameter('vid','STRING',vid)]
    live=list(b.query('SELECT COUNT(*) n FROM `youtubetranscripts-429803.reptranscripts.youtube_videos` WHERE video_id=@vid',job_config=bigquery.QueryJobConfig(query_parameters=params)).result())[0]['n']
    if not live:raise ValueError('Source not in live library')
    cull_ids={r['video_id'] for r in b.query('SELECT video_id FROM `youtubetranscripts-429803.snippy_history.cull_20260930_decisions`').result()}
    if vid in cull_ids:raise ValueError('Culled source forbidden')
    s=AuthorizedSession(google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])[0]);url='https://storage.googleapis.com/storage/v1/b/'+BUCKET+'/o/'+quote(name,safe='')
    meta=s.get(url,timeout=30)
    md5=base64.b64encode(hashlib.md5(media_path.read_bytes()).digest()).decode()
    if meta.status_code==404:
        with media_path.open('rb') as f:r=s.post(f'https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o',params={'uploadType':'media','name':name,'ifGenerationMatch':'0'},headers={'Content-Type':'video/mp4'},data=f,timeout=180)
        r.raise_for_status()
        meta=s.get(url,timeout=30)
    meta.raise_for_status();stored=meta.json()
    if stored.get('md5Hash')!=md5 or int(stored['size'])!=media_path.stat().st_size:raise ValueError('Uploaded bytes mismatch')
    public=f'https://storage.googleapis.com/{BUCKET}/{name}'
    response=requests.get(public,headers={'Range':'bytes=0-31'},timeout=30);response.raise_for_status()
    if response.status_code!=206 or response.content!=media_path.read_bytes()[:32]:raise ValueError('Public playback range verification failed')
    row={'snippet_id':sid,'original_video_id':vid,'title':recipe['title'],'description':recipe['reason']+' '+recipe['edit_notes'],'category':'ai_safety','duration_ms':round(sum(e['end_seconds']-e['start_seconds'] for e in recipe['edits'])*1000),'transcript':' '.join(e['transcript'] for e in recipe['edits']),'gcs_url':public,'provider':'astra','speaker':recipe['speaker']}
    params=[bigquery.ScalarQueryParameter(k,'INT64' if k=='duration_ms' else 'STRING',v) for k,v in row.items()]
    cols=', '.join(row);vals=', '.join('@'+k for k in row)
    sql=f'MERGE `{TABLE}` T USING (SELECT @snippet_id snippet_id) S ON T.snippet_id=S.snippet_id WHEN NOT MATCHED THEN INSERT ({cols},created_at) VALUES ({vals},CURRENT_TIMESTAMP())'
    job=b.query(sql,job_config=bigquery.QueryJobConfig(query_parameters=params));job.result()
    rows=[dict(r) for r in b.query(f'SELECT * FROM `{TABLE}` WHERE snippet_id=@id',job_config=bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter('id','STRING',sid)])).result()]
    if len(rows)!=1 or any(rows[0][k]!=v for k,v in row.items()):raise ValueError('DB receipt mismatch or duplicate')
    receipt={'passed':True,'time':audit.now(),'snippet_id':sid,'video_id':vid,'gcs_url':public,'gcs_generation':stored['generation'],'media_sha256':sha,'recipe_hash':rh,'uploaded_bytes':media_path.stat().st_size,'row':{k:str(v) for k,v in rows[0].items()},'query_job':job.job_id}
    audit.atomic(out,receipt);print(json.dumps(receipt,indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--recipe',type=Path,required=True);p.add_argument('--media',type=Path,required=True);p.add_argument('--qa',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();publish(a.recipe,a.media,a.qa,a.out)
