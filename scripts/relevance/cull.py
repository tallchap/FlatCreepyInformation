#!/usr/bin/env python3
"""Archive and cull the exact approved 915-video set. Every destructive step is gated."""
import argparse
import collections
import concurrent.futures
import csv
import gzip
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import time
import threading
import zipfile

import requests
from google.cloud import bigquery
import audit

PROJECT='youtubetranscripts-429803'
SOURCE=PROJECT+'.reptranscripts'
HISTORY=PROJECT+'.snippy_history'
PREFIX='cull_20260930_'
STORE='vs_69b1015315d88191b6f26c169575bc4c'
AUDIT=Path('.context/relevance')
OUT=Path('.context/cull-20260930')
EXPECTED=915


def read(path):return json.loads(path.read_text())
def target(table):
    if not re.fullmatch(r'[A-Za-z0-9_]+',table):raise ValueError('Invalid table identifier')
    return HISTORY+'.'+PREFIX+table


def approved():
    rows=list(csv.DictReader((AUDIT/'no-clipworthy-passage.csv').open(encoding='utf-8-sig')))
    ids=[r['video_id'] for r in rows]
    if len(ids)!=EXPECTED or len(set(ids))!=EXPECTED:raise ValueError('Expected exactly 915 distinct approved IDs')
    if not read(AUDIT/'verification.json')['passed']:raise ValueError('Audit verification did not pass')
    for row in rows:
        result=read(AUDIT/'results'/f"{row['video_id']}.json")
        if result['status']!='no_passage' or result['assessment']['eligible'] or result['assessment']['has_self_contained_ai_passage']:
            raise ValueError('Unapproved result '+row['video_id'])
        if result['protected_matches'] or row['protected_speakers'] or audit.protected(row):
            raise ValueError('Protected video in cull set '+row['video_id'])
    return rows,sorted(ids)


def query(b,sql,params=()):
    job=b.query(sql,job_config=bigquery.QueryJobConfig(query_parameters=list(params)))
    return job,list(job.result())


def prepare():
    rows,ids=approved();OUT.mkdir(parents=True,exist_ok=True)
    b=audit.bq_client();decisions=target('decisions')
    ds=bigquery.Dataset(HISTORY);ds.location='US';ds.description='Permanent historical records for explicitly approved Snippy database culls. No expiration.'
    ds.default_table_expiration_ms=None;b.create_dataset(ds,exists_ok=True)
    live_ds=b.get_dataset(HISTORY)
    if live_ds.default_table_expiration_ms is not None:raise ValueError('Archive dataset must not expire')
    idset=set(ids);decision_rows=[]
    for row in audit.inputs(AUDIT):
        if row['video_id'] not in idset:continue
        result=read(AUDIT/'results'/f"{row['video_id']}.json")
        decision_rows.append({'video_id':row['video_id'],'title':row['title'],'speaker_source':row['speaker_source'],
            'channel':row['publisher'],'url':row['url'],'reason':result['assessment']['passage_reason'],
            'assessment_json':json.dumps(result,ensure_ascii=False),'transcript_text':row['transcript'],
            'transcript_sha256':hashlib.sha256(row['transcript'].encode()).hexdigest(),'input_hash':row['input_hash']})
    schema=[bigquery.SchemaField(k,'STRING') for k in decision_rows[0]]
    try:
        b.get_table(decisions)
    except Exception as e:
        from google.api_core.exceptions import NotFound
        if not isinstance(e,NotFound):raise
        b.load_table_from_json(decision_rows,decisions,job_config=bigquery.LoadJobConfig(schema=schema,write_disposition='WRITE_EMPTY')).result()
    _,actual=query(b,f'SELECT video_id,transcript_sha256 FROM `{decisions}`')
    if {r['video_id']:r['transcript_sha256'] for r in actual}!={r['video_id']:r['transcript_sha256'] for r in decision_rows}:
        raise ValueError('Existing decision archive differs from approved set')
    manifest_path=OUT/'manifest.json'
    if manifest_path.exists():
        manifest=read(manifest_path)
        if manifest['ids']!=ids:raise ValueError('Existing manifest has another cull set')
        return manifest
    _,time_rows=query(b,'SELECT CURRENT_TIMESTAMP() ts')
    snapshot=time_rows[0]['ts'].isoformat()
    tables=read(AUDIT/'cull-related-tables.json')
    tables=[r for r in tables if r['table_type']=='BASE TABLE']
    manifest={'created_at':audit.now(),'snapshot':snapshot,'approved_count':EXPECTED,'ids':ids,
        'ids_sha256':audit.digest(ids),'dataset':HISTORY,'table_prefix':PREFIX,'tables':tables,
        'protected_speakers':list(audit.PROTECTED),'audit_commit':'f7d4d77',
        'approval':'User explicitly requested archival of all metadata/transcripts followed by deletion of the 915 no-passage videos.',
        'status':'prepared','media_policy':'Text and structured data only. No footage or audio is downloaded or archived.',
        'note':'Only rows keyed to these video IDs are culled. External media objects and original OpenAI file objects are retained.'}
    audit.atomic(manifest_path,manifest)
    for name in ['no-clipworthy-passage.csv','summary.json','verification.json']:
        shutil.copy2(AUDIT/name,OUT/('audit-'+name))
    for name in ['snippy-triage-v1.txt','audit-addendum-v1.txt']:
        shutil.copy2(audit.ROOT/name,OUT/name)
    audit.atomic(OUT/'decisions.json',decision_rows)
    return manifest


def archive():
    m=prepare();b=audit.bq_client();decisions=target('decisions')
    stamp=bigquery.ScalarQueryParameter('snapshot','TIMESTAMP',m['snapshot'])
    for row in m['tables']:
        table,key=row['table_name'],row['column_name'];dest=target(table)
        sql=f'''CREATE TABLE IF NOT EXISTS `{dest}` OPTIONS(description='Permanent archive before approved September 30 2026 cull; restore only from manifest.') AS
            SELECT s.* FROM `{SOURCE}.{table}` AS s FOR SYSTEM_TIME AS OF @snapshot
            WHERE s.{key} IN (SELECT video_id FROM `{decisions}`)'''
        job,_=query(b,sql,[stamp]);t=b.get_table(dest)
        if t.expires is not None:raise ValueError('Archive expiration is set')
        row.update({'archive_table':dest,'archive_rows':t.num_rows,'archive_job_id':job.job_id})
        audit.atomic(OUT/'schemas'/f'{table}.json',[f.to_api_repr() for f in t.schema])
        audit.atomic(OUT/'manifest.json',m)
        print('Archived',table,t.num_rows,flush=True)
    # A grouped fingerprint comparison retains duplicate-row multiplicity.
    statements=[]
    for row in m['tables']:
        table,key=row['table_name'],row['column_name'];dest=target(table)
        left=f'SELECT TO_JSON_STRING(s) row_json,COUNT(*) n FROM `{SOURCE}.{table}` AS s FOR SYSTEM_TIME AS OF @snapshot WHERE {key} IN (SELECT video_id FROM `{decisions}`) GROUP BY row_json'
        right=f'SELECT TO_JSON_STRING(s) row_json,COUNT(*) n FROM `{dest}` s GROUP BY row_json'
        statements.append(f"SELECT '{table}' table_name, (SELECT COUNT(*) FROM (({left}) EXCEPT DISTINCT ({right}))) missing, (SELECT COUNT(*) FROM (({right}) EXCEPT DISTINCT ({left}))) extra")
    job,checks=query(b,' UNION ALL '.join(statements),[stamp])
    checks=[dict(r) for r in checks]
    if any(r['missing'] or r['extra'] for r in checks):raise ValueError('Archive differs from source snapshot')
    t=target('youtube_transcript_segments')
    sql=fr'''WITH seg AS (SELECT DISTINCT video_id,start_sec,text FROM `{t}` WHERE TRIM(COALESCE(text,''))!=''),
      transcripts AS (SELECT video_id,STRING_AGG(CONCAT('[',COALESCE(CAST(start_sec AS STRING),'unknown'),'] ',text),'\n' ORDER BY COALESCE(start_sec,1e12),text) transcript FROM seg GROUP BY video_id)
      SELECT d.video_id FROM `{decisions}` d LEFT JOIN transcripts t USING(video_id)
      WHERE t.transcript IS NULL OR LOWER(TO_HEX(SHA256(t.transcript)))!=LOWER(d.transcript_sha256)'''
    _,changed=query(b,sql)
    if changed:raise ValueError('Transcripts changed since audit: '+str([r['video_id'] for r in changed]))
    _,videos=query(b,f'SELECT * FROM `{target("youtube_videos")}`')
    if {r['video_id'] for r in videos}!=set(m['ids']):raise ValueError('Archive video ID set mismatch')
    for r in videos:
        if audit.protected({'title':r['video_title'],'publisher':r['channel_name'],'speaker_source':r['speaker_source']}):
            raise ValueError('Protected speaker in current metadata: '+r['video_id'])
    audit.atomic(OUT/'archive-verification.json',{'time':audit.now(),'passed':True,'table_checks':checks,
        'video_ids':len(videos),'transcripts_match_audit':True,'no_protected_metadata':True,'query_job':job.job_id})
    m['status']='cloud_archive_verified';audit.atomic(OUT/'manifest.json',m)
    print('Cloud archive verified',len(videos),'videos',flush=True)


def local_export():
    m=read(OUT/'manifest.json')
    if not read(OUT/'archive-verification.json')['passed']:raise ValueError('Cloud archive not verified')
    b=audit.bq_client();records={r['video_id']:r for r in read(OUT/'decisions.json')}
    # Historical reference includes every original metadata field and full original segment rows.
    sql=f'''WITH segments AS (SELECT video_id,
        TO_JSON_STRING(ARRAY_AGG(s ORDER BY COALESCE(s.start_sec,1e12),s.segment_index,s.text)) segments_json
        FROM `{target('youtube_transcript_segments')}` s GROUP BY video_id)
        SELECT v.video_id,TO_JSON_STRING(v) metadata_json,s.segments_json
        FROM `{target('youtube_videos')}` v JOIN segments s USING(video_id) ORDER BY v.video_id'''
    job=b.query(sql)
    (OUT/'videos').mkdir(exist_ok=True);(OUT/'transcripts').mkdir(exist_ok=True)
    n=0;segment_count=0
    for r in job.result(page_size=100):
        vid=r['video_id'];record=records[vid];metadata=json.loads(r['metadata_json']);segments=json.loads(r['segments_json'])
        archive={'metadata':metadata,'transcript_segments':segments,'luna_assessment':json.loads(record['assessment_json'])}
        audit.atomic(OUT/'videos'/f'{vid}.json',archive)
        (OUT/'transcripts'/f'{vid}.txt').write_text(record['transcript_text'],encoding='utf-8')
        segment_count+=len(segments);n+=1
        if n%100==0:print('Exported',n,flush=True)
    if n!=EXPECTED:raise ValueError('Local export count mismatch')
    expected=next(r['archive_rows'] for r in m['tables'] if r['table_name']=='youtube_transcript_segments')
    if segment_count!=expected:raise ValueError('Local transcript segment count mismatch')
    # Also export associated data verbatim; large derived search-window copies stay in BigQuery.
    for row in m['tables']:
        if row['table_name'] in ('youtube_videos','youtube_transcript_segments','segment_search_windows'):continue
        _,data=query(b,f'SELECT TO_JSON_STRING(t) j FROM `{row["archive_table"]}` t')
        path=OUT/'related'/f'{row["table_name"]}.jsonl.gz';path.parent.mkdir(exist_ok=True)
        with gzip.open(path,'wt',encoding='utf-8') as f:
            for r in data:f.write(r['j']+'\n')
    render_index(records)
    audit.atomic(OUT/'local-verification.json',{'time':audit.now(),'passed':True,'videos':n,'transcript_segments':segment_count,
        'source':'Verified permanent BigQuery archive','files_sha256':{str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['videos','transcripts','related'] for p in (OUT/folder).glob('*')}})
    m['status']='cloud_and_local_archive_verified';audit.atomic(OUT/'manifest.json',m)
    print('Local archive verified',n,segment_count,flush=True)


def render_index(records):
    cards=[]
    for vid,r in sorted(records.items(),key=lambda x:(x[1]['speaker_source'] or '',x[1]['title'] or '')):
        cards.append('<article><h2>'+html.escape(r['title'] or vid)+'</h2><p>'+html.escape(r['speaker_source'] or '')+' · '+html.escape(r['channel'] or '')+'</p><p><code>'+vid+'</code> · <a href="transcripts/'+vid+'.txt">Full transcript</a> · <a href="videos/'+vid+'.json">Complete metadata and original segments</a></p><p>'+html.escape(r['reason'])+'</p></article>')
    page='''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Snippy historical archive — 915 culled videos</title><style>body{font:16px system-ui;max-width:1050px;margin:32px auto;padding:0 20px;background:#f4f7fa;color:#183047}input{font:inherit;width:95%;padding:12px}article{background:white;margin:15px 0;padding:20px;border:1px solid #d4dee6;border-radius:8px}h2{font-size:20px}a{color:#075b9d}p{line-height:1.5}</style><h1>Snippy historical archive</h1><p>915 videos archived September 30, 2026, before the approved cull. This archive contains TEXT AND METADATA ONLY — no video footage or audio. Names, IDs, full metadata, original transcript segments, timestamped text, and Luna reasons are preserved. Permanent cloud copy: youtubetranscripts-429803.snippy_history, tables beginning cull_20260930_.</p><p><a href="audit-no-clipworthy-passage.csv">Video list CSV</a> · <a href="manifest.json">Restoration manifest</a> · <a href="archive-verification.json">Cloud archive verification</a> · <a href="cull-verification.json">Database and search verification</a> · <a href="gcs-verification.json">Permanent footage deletion verification</a> · <a href="README.txt">Archive instructions</a></p><input id="q" placeholder="Search names, titles, IDs or reasons" aria-label="Search archive"><p id="n">915 videos</p>__CARDS__<script>const cards=[...document.querySelectorAll('article')];document.getElementById('q').oninput=e=>{let n=0;for(const c of cards){c.hidden=!c.textContent.toLowerCase().includes(e.target.value.toLowerCase());if(!c.hidden)n++}document.getElementById('n').textContent=n+' videos'}</script>'''
    (OUT/'index.html').write_text(page.replace('__CARDS__',''.join(cards)),encoding='utf-8')


def vector_plan():
    m=read(OUT/'manifest.json');ids=set(m['ids']);before=read(OUT/'vector-before.json')
    citation=read(Path('src/lib/shared-store-citation-map.json'))['files']
    metadata={r['id']:r for r in read(OUT/'vector-file-metadata.json')}
    matched=[];conflicts=[];unmapped=[]
    for row in before:
        attrs=row.get('attributes') or {};vid=attrs.get('video_id');fallback=citation.get(row['id'],{}).get('videoId')
        filename=metadata.get(row['id'],{}).get('filename','')
        parsed=re.fullmatch(r'transcript_([A-Za-z0-9_-]{11})_(.+)\.txt',filename)
        from_name=parsed.group(1) if parsed else None
        candidates={v for v in (vid,fallback,from_name) if v}
        if len(candidates)>1:raise ValueError('Conflicting file identity: '+row['id'])
        vid=vid or fallback or from_name
        if vid is None:unmapped.append(row['id']);continue
        if vid not in ids:continue
        if fallback and attrs.get('video_id') and fallback!=vid:raise ValueError('Conflicting vector video IDs')
        entry={**row,'mapped_video_id':vid,'filename':filename};matched.append(entry)
        names=audit.protected({'speaker_source':(attrs.get('speaker') or '')+' '+(parsed.group(2).replace('-',' ') if parsed else ''),'title':attrs.get('title'),'publisher':attrs.get('channel')})
        if names:conflicts.append({'video_id':vid,'file_id':row['id'],'protected':names,'attributes':attrs})
    audit.atomic(OUT/'vector-matches.json',matched)
    audit.atomic(OUT/'vector-plan.json',{'store':STORE,'before_files':len(before),'files_to_detach':len(matched),
        'video_ids':len({r['mapped_video_id'] for r in matched}),'protected_conflicts':conflicts,'unmapped_files':unmapped})
    print('Vector plan:',len(matched),'files;',len(conflicts),'protected conflicts;',len(unmapped),'unmapped',flush=True)
    if conflicts or unmapped:raise ValueError('Vector inventory needs investigation before deletion')


def difference_sql(left,right):
    return f'(SELECT COUNT(*) FROM (({left}) EXCEPT DISTINCT ({right})))=0 AND (SELECT COUNT(*) FROM (({right}) EXCEPT DISTINCT ({left})))=0'


def deletion_sql(m):
    if len(m['ids'])!=EXPECTED or len(set(m['ids']))!=EXPECTED:raise ValueError('Exactly 915 unique IDs required')
    if any(not re.fullmatch(r'[A-Za-z0-9_-]{11}',v) for v in m['ids']):raise ValueError('Invalid video ID')
    decisions=target('decisions');lines=['BEGIN TRANSACTION;']
    lines.append(f'ASSERT (SELECT COUNT(*) FROM `{decisions}`)=915 AS "exactly 915 decisions required";')
    lines.append(f'ASSERT (SELECT COUNT(DISTINCT video_id) FROM `{SOURCE}.youtube_videos` WHERE video_id IN UNNEST(@ids))=915 AS "live video set changed";')
    lines.append(f'ASSERT (SELECT COUNT(*) FROM `{decisions}` WHERE video_id NOT IN UNNEST(@ids))=0 AS "archive IDs differ from approved IDs";')
    lines.append(f'''ASSERT (SELECT COUNT(*) FROM `{SOURCE}.youtube_videos` WHERE video_id IN UNNEST(@ids)
        AND REGEXP_CONTAINS(NORMALIZE_AND_CASEFOLD(CONCAT(COALESCE(speaker_source,''),' ',COALESCE(video_title,''),' ',COALESCE(channel_name,'')),NFKC),@protected))=0 AS "protected speaker detected";''')
    for row in m['tables']:
        table,key=row['table_name'],row['column_name']
        target(table)
        if key not in ('video_id','original_video_id'):raise ValueError('Unsupported identity column')
        left=f'SELECT TO_JSON_STRING(s) row_json,COUNT(*) n FROM `{SOURCE}.{table}` s WHERE {key} IN UNNEST(@ids) GROUP BY row_json'
        right=f'SELECT TO_JSON_STRING(s) row_json,COUNT(*) n FROM `{target(table)}` s GROUP BY row_json'
        lines.append(f'ASSERT ({difference_sql(left,right)}) AS "archive no longer matches {table}";')
    for row in m['tables']:
        table,key=row['table_name'],row['column_name']
        lines.append(f'DELETE FROM `{SOURCE}.{table}` WHERE {key} IN UNNEST(@ids);')
        lines.append(f'ASSERT @@row_count={row["archive_rows"]} AS "unexpected delete count in {table}";')
    lines.append('COMMIT TRANSACTION;')
    return '\n'.join(lines)


def delete_database():
    m=read(OUT/'manifest.json');_,ids=approved()
    if ids!=m['ids'] or audit.digest(ids)!=m['ids_sha256']:raise ValueError('Approved ID manifest changed')
    for name in ['archive-verification.json','local-verification.json']:
        if not read(OUT/name)['passed']:raise ValueError(name+' not verified')
    local=read(OUT/'local-verification.json')
    for rel,h in local['files_sha256'].items():
        if hashlib.sha256((OUT/rel).read_bytes()).hexdigest()!=h:raise ValueError('Local archive changed: '+rel)
    vp=read(OUT/'vector-plan.json')
    if vp['protected_conflicts'] or vp['unmapped_files']:raise ValueError('Unresolved vector inventory')
    b=audit.bq_client();sql=deletion_sql(m);(OUT/'delete-executed.sql').write_text(sql)
    # Capture non-target metadata to verify that retained library videos are unchanged.
    _,retained=query(b,f'SELECT TO_JSON_STRING(v) row_json FROM `{SOURCE}.youtube_videos` v WHERE video_id NOT IN UNNEST(@ids)',[bigquery.ArrayQueryParameter('ids','STRING',ids)])
    audit.atomic(OUT/'retained-videos-before.json',sorted(r['row_json'] for r in retained))
    job_id='snippy_cull_20260930_'+m['ids_sha256'][:16]
    params=[bigquery.ArrayQueryParameter('ids','STRING',ids),bigquery.ScalarQueryParameter('protected','STRING','|'.join(audit.PROTECTED.values()))]
    # Deterministic job ID lets an interrupted client recover the receipt without submitting again.
    from google.api_core.exceptions import Conflict
    try:job=b.query(sql,job_id=job_id,job_retry=None,job_config=bigquery.QueryJobConfig(query_parameters=params))
    except Conflict:job=b.get_job(job_id,location='US')
    job.result()
    audit.atomic(OUT/'database-deletion.json',{'time':audit.now(),'job_id':job.job_id,'deleted_videos':915,'tables':m['tables'],'committed':True})
    print('Database transaction committed',job.job_id,flush=True)


def detach_vectors():
    if not read(OUT/'database-deletion.json')['committed']:raise ValueError('Database transaction not committed')
    matches=read(OUT/'vector-matches.json');key=audit.api_key();receipts=OUT/'vector-detach-receipts';receipts.mkdir(exist_ok=True)
    rate_lock=threading.Lock();next_request=[0.0]
    def one(row):
        path=receipts/(row['id']+'.json')
        if path.exists() and read(path).get('deleted'):return
        url=f'https://api.openai.com/v1/vector_stores/{STORE}/files/{row["id"]}'
        for attempt in range(10):
            with rate_lock:
                delay=max(0,next_request[0]-time.monotonic())
                if delay:time.sleep(delay)
                next_request[0]=time.monotonic()+0.26
            r=requests.delete(url,headers={'Authorization':'Bearer '+key},timeout=60)
            if r.status_code==200:
                data=r.json()
                if not data.get('deleted') or data.get('id')!=row['id']:raise ValueError('Unexpected detach response')
                audit.atomic(path,data);return
            if r.status_code==404:
                audit.atomic(path,{'id':row['id'],'deleted':True,'already_absent':True});return
            if r.status_code in (429,500,502,503,504):
                time.sleep(min(45,max(2**attempt,15 if r.status_code==429 else 1)));continue
            raise RuntimeError(f'Detach {r.status_code}: {r.text[:200]}')
        raise RuntimeError('Detach retries exhausted: '+row['id'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for i,_ in enumerate(pool.map(one,matches),1):
            if i%100==0:print('Detached',i,'/',len(matches),flush=True)
    print('Vector detach complete',len(matches),flush=True)


def verify():
    m=read(OUT/'manifest.json');b=audit.bq_client();ids=m['ids'];params=[bigquery.ArrayQueryParameter('ids','STRING',ids)]
    sql=' UNION ALL '.join(f"SELECT '{r['table_name']}' table_name,COUNT(*) remaining FROM `{SOURCE}.{r['table_name']}` WHERE {r['column_name']} IN UNNEST(@ids)" for r in m['tables'])
    _,rows=query(b,sql,params);remaining=[dict(r) for r in rows]
    _,retained=query(b,f'SELECT TO_JSON_STRING(v) row_json FROM `{SOURCE}.youtube_videos` v WHERE video_id NOT IN UNNEST(@ids)',params)
    unchanged=sorted(r['row_json'] for r in retained)==read(OUT/'retained-videos-before.json')
    # Fresh, paginated readback of the active search store.
    s=requests.Session();s.headers['Authorization']='Bearer '+audit.api_key();files=[];p={'limit':100}
    while True:
        r=s.get(f'https://api.openai.com/v1/vector_stores/{STORE}/files',params=p,timeout=60);r.raise_for_status();data=r.json();files.extend(data['data'])
        if not data.get('has_more'):break
        p['after']=data['last_id']
    audit.atomic(OUT/'vector-after.json',files)
    before={r['id'] for r in read(OUT/'vector-before.json')};targets={r['id'] for r in read(OUT/'vector-matches.json')};after={r['id'] for r in files}
    checks={'culled_ids_absent_from_all_live_tables':all(r['remaining']==0 for r in remaining),
        'retained_video_metadata_unchanged':unchanged,'exact_vector_files_detached':after==before-targets,
        'cloud_archive_verified':read(OUT/'archive-verification.json')['passed'],'local_archive_verified':read(OUT/'local-verification.json')['passed']}
    _,cloud=query(b,' UNION ALL '.join(f"SELECT '{r['table_name']}' table_name,COUNT(*) n FROM `{r['archive_table']}`" for r in m['tables']))
    checks['permanent_archive_counts_intact']={r['table_name']:r['n'] for r in cloud}=={r['table_name']:r['archive_rows'] for r in m['tables']}
    protected_ids={r['video_id'] for r in csv.DictReader((AUDIT/'preserved.csv').open(encoding='utf-8-sig'))}
    live_ids={json.loads(r['row_json'])['video_id'] for r in retained}
    checks['all_1029_preserved_videos_remain']=len(protected_ids)==1029 and protected_ids<=live_ids
    if (OUT/'gcs-delete-plan.json').exists():
        checks['matching_gcs_footage_permanently_removed']=read(OUT/'gcs-verification.json')['passed']
    receipt={'time':audit.now(),'requested':'Archive and delete exact 915 approved no-passage videos, preserving seven protected speakers.',
        'deleted_videos':915,'remaining_videos':len({json.loads(r['row_json'])['video_id'] for r in retained}),'remaining_metadata_rows':len(retained),'remaining_by_table':remaining,
        'vector_files_detached':len(targets),'vector_files_remaining':len(after),'checks':checks,'passed':all(checks.values()),
        'archive_dataset':HISTORY,'archive_prefix':PREFIX,'database_job':read(OUT/'database-deletion.json')['job_id']}
    audit.atomic(OUT/'cull-verification.json',receipt);print(json.dumps(receipt,indent=2),flush=True)
    if not receipt['passed']:raise ValueError('Post-deletion verification failed')
    m['status']='culled_and_verified';m['completed_at']=audit.now();audit.atomic(OUT/'manifest.json',m)


def bundle():
    with zipfile.ZipFile(OUT/'snippy-cull-915-2026-09-30.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for path in OUT.rglob('*'):
            if path.is_file() and path.suffix!='.zip':z.write(path,path.relative_to(OUT))
    print('Archive bundle',OUT/'snippy-cull-915-2026-09-30.zip',flush=True)


def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['archive','export','vector-plan','delete-database','detach-vectors','verify','bundle']);a=p.parse_args()
    {'archive':archive,'export':local_export,'vector-plan':vector_plan,'delete-database':delete_database,'detach-vectors':detach_vectors,'verify':verify,'bundle':bundle}[a.command]()

if __name__=='__main__':main()
