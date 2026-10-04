#!/usr/bin/env python3
"""Read-only Snippy corpus audit; exact Daily Clips prompt, protected-speaker bypass."""
import argparse
import concurrent.futures
import csv
import datetime as dt
import hashlib
import html
import json
import os
from pathlib import Path
import re
import time
import unicodedata

ROOT = Path(__file__).resolve().parent
DEFAULT_RUN = Path('.context/relevance')
SOURCE = 'youtubetranscripts-429803.reptranscripts'
MODEL = 'gpt-6-luna'
PROMPT_SOURCE = 'tallchap/snippy-daily-clips@1303f5d:config/prompts/triage/snippy-triage-v1.txt'
PROTECTED = {
    'Sam Altman': r'\b(?:sam|samuel)\s+altman\b',
    'Dario Amodei': r'\bdario\s+amodei\b',
    'Demis Hassabis': r'\b(?:demis\s+)?hassabis\b',
    'Eliezer Yudkowsky': r'\b(?:eliezer\s+)?yudkowsky\b',
    'Max Tegmark': r'\b(?:max\s+)?tegmark\b',
    'Yoshua Bengio': r'\byoshua\s+bengio\b',
    'Yann LeCun': r'\b(?:yann\s+)?le\s*cun\b',
    # Added to the keep list 2026-10-01.
    'Geoffrey Hinton': r'\b(?:geoff(?:rey)?\s+)?hinton\b',
    'Nate Soares': r'\bnate\s+soares\b',
    # Added to the keep list 2026-10-03 (top 10 speakers).
    'Elon Musk': r'\belon\s+musk\b',
    'Connor Leahy': r'\bconnor\s+leahy\b',
}
SAFETY = ['direct', 'adjacent', 'indirect', 'none']
TIMELINE = ['direct', 'mechanism', 'governance', 'indirect', 'adjacent', 'infrastructure', 'none']
PROPERTIES = {
    'eligible': {'type':'boolean'}, 'original': {'type':'boolean'},
    'has_self_contained_ai_passage': {'type':'boolean'}, 'passage_reason': {'type':'string'},
    'source_type': {'type':'string'}, 'speaker': {'type':'string'},
    'safety_fit': {'type':'string','enum':SAFETY},
    'timeline_fit': {'type':'string','enum':TIMELINE}, 'reason': {'type':'string'},
    'vitrupo_score': {'type':'integer'},
    'best_moment': {'type':'object','additionalProperties':False,
                    'required':['start_seconds','end_seconds','claim','quote'],
                    'properties':{'start_seconds':{'type':'number'},'end_seconds':{'type':'number'},
                                  'claim':{'type':'string'},'quote':{'type':'string'}}},
}
SCHEMA = {'type':'object','additionalProperties':False,'required':list(PROPERTIES),'properties':PROPERTIES}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2,default=str),encoding='utf-8')
    tmp.replace(path)


def digest(data):
    return hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False,default=str).encode()).hexdigest()


def protected(row):
    # Conservative metadata matching also preserves title-only references. Merely
    # discussing a person's name in an unrelated transcript does not identify a speaker.
    found = {}
    for field in ('speaker_source','title','publisher','speaker'):
        value = unicodedata.normalize('NFKC',row.get(field) or '').casefold()
        for name, pattern in PROTECTED.items():
            if re.search(pattern,value): found.setdefault(name,[]).append(field)
    return found


def bq_client():
    from google.cloud import bigquery
    key = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', str(Path.home()/'Desktop/ClaudeCode/gcp-service-account.json'))
    return bigquery.Client.from_service_account_json(key)


def snapshot(run):
    path = run/'inputs.jsonl'
    if path.exists():
        print('Using immutable snapshot',path,flush=True)
        return
    q = fr'''WITH meta AS (
        SELECT video_id, ARRAY_AGG(STRUCT(video_title,channel_name,published_date,youtube_link,video_length,created_time)
            ORDER BY created_time DESC LIMIT 1)[OFFSET(0)] m,
            STRING_AGG(DISTINCT speaker_source, ', ') speaker_source, COUNT(*) metadata_rows
        FROM `{SOURCE}.youtube_videos` GROUP BY video_id
    ), seg AS (
        SELECT video_id,start_sec,text,MAX(end_sec) end_sec
        FROM `{SOURCE}.youtube_transcript_segments`
        GROUP BY video_id,start_sec,text
    ), trans AS (
        SELECT video_id, STRING_AGG(CONCAT('[',COALESCE(CAST(start_sec AS STRING),'unknown'),'] ',text),'\n'
            ORDER BY COALESCE(start_sec,1e12),text) transcript,
            STRING_AGG(text,' ' ORDER BY COALESCE(start_sec,1e12),text) plain_text,
            MAX(COALESCE(end_sec,start_sec)) last_timestamp, COUNT(*) segment_count
        FROM seg WHERE TRIM(COALESCE(text,'')) != '' GROUP BY video_id
    ) SELECT meta.video_id, m.video_title title,m.channel_name publisher,
        CAST(m.published_date AS STRING) published_at,m.youtube_link url,m.video_length,
        speaker_source, metadata_rows, trans.transcript,trans.plain_text,trans.last_timestamp,trans.segment_count
        FROM meta LEFT JOIN trans USING(video_id) ORDER BY meta.video_id'''
    started = now()
    job = bq_client().query(q)
    tmp = run/'inputs.jsonl.tmp'
    run.mkdir(parents=True,exist_ok=True)
    n = 0
    with tmp.open('w',encoding='utf-8') as f:
        for r in job.result(page_size=100):
            row = dict(r)
            row['url'] = row['url'] or 'https://www.youtube.com/watch?v='+row['video_id']
            row['protected_matches'] = protected(row)
            row['input_hash'] = digest(row)
            f.write(json.dumps(row,ensure_ascii=False,default=str)+'\n')
            n+=1
            if n%500 == 0: print('Snapshot',n,flush=True)
    tmp.replace(path)
    atomic(run/'snapshot.json',{'created_at':started,'completed_at':now(),'unique_videos':n,
        'query_job':job.job_id,'source':SOURCE,'bytes_processed':job.total_bytes_processed,
        'prompt_source':PROMPT_SOURCE,'prompt_sha256':hashlib.sha256((ROOT/'snippy-triage-v1.txt').read_bytes()).hexdigest(),
        'protected_speakers':list(PROTECTED),'sql':q})
    print('Snapshot complete',n,flush=True)


def inputs(run):
    with (run/'inputs.jsonl').open(encoding='utf-8') as f:
        for line in f: yield json.loads(line)


def request_body(row):
    meta = {k:row.get(k) for k in ('title','publisher','published_at','url')}
    meta['known_speakers'] = row.get('speaker_source')
    meta['duration_seconds'] = row.get('last_timestamp')
    return {'model':MODEL,'instructions':(ROOT/'snippy-triage-v1.txt').read_text().strip()+'\n\n'+(ROOT/'audit-addendum-v1.txt').read_text().strip(),
        'input':'Candidate metadata:\n'+json.dumps(meta,ensure_ascii=False)+'\n\nFull source transcript (timestamps in seconds):\n'+row['transcript'],
        'text':{'format':{'type':'json_schema','name':'snippy_triage_v1','schema':SCHEMA,'strict':True}},
        'max_output_tokens':12000}


def price(data):
    u = data.get('usage') or {}
    inp,out = u.get('input_tokens',0),u.get('output_tokens',0)
    details=u.get('input_tokens_details') or {}
    cached=details.get('cached_tokens',0)
    writes=details.get('cache_write_tokens',0)
    return (max(0,inp-cached-writes)*.1+writes*.125+cached*.01)*(2 if inp>272000 else 1)/1e6 + out*.5*(1.5 if inp>272000 else 1)/1e6


def evidence(row,out):
    m = out['best_moment']; start,end = m['start_seconds'],m['end_seconds']
    quote = ' '.join(m['quote'].split())
    plain = ' '.join((row.get('plain_text') or '').split())
    checks = {'duration_15_240':15<=end-start<=240,'timestamps_in_source':0<=start<end<=(row.get('last_timestamp') or 0)+5,
              'quote_in_transcript':bool(quote) and quote in plain}
    # Timestamps are approximate. Check quote against the proposed passage with a
    # 5-second caption tolerance, separately from whole-transcript containment.
    passage=[]
    for line in row['transcript'].splitlines():
        match=re.match(r'^\[([\d.]+)\] (.*)$',line)
        if match and start-5<=float(match[1])<=end+5: passage.append(match[2])
    checks['quote_in_passage'] = bool(quote) and quote in ' '.join(' '.join(passage).split())
    return checks


def classify(row,raw):
    import jsonschema
    if raw.get('status') != 'completed': raise ValueError('Response not completed: '+str(raw.get('status')))
    text=''.join(c.get('text','') for o in raw.get('output',[]) if o.get('type')=='message'
                 for c in o.get('content',[]) if c.get('type')=='output_text')
    out=json.loads(text)
    jsonschema.validate(out,SCHEMA)
    if not 0<=out['vitrupo_score']<=10:raise ValueError('Score outside 0-10')
    if out['eligible'] and not (out['original'] and out['has_self_contained_ai_passage']):
        raise ValueError('Contradictory eligibility labels')
    if not out['has_self_contained_ai_passage'] and (out['best_moment']['quote'] or out['best_moment']['start_seconds'] or out['best_moment']['end_seconds']):
        raise ValueError('No-passage judgment contains a proposed passage')
    late_protected=protected({'speaker':out['speaker']})
    checks=evidence(row,out)
    qualifies=out['eligible'] and out['original'] and out['has_self_contained_ai_passage']
    status='preserved' if late_protected else ('eligible' if qualifies and all(checks.values()) else 'review' if qualifies else 'no_passage' if not out['has_self_contained_ai_passage'] else 'not_eligible')
    return {'status':status,'assessment':out,'evidence_checks':checks,'protected_matches':late_protected,
            'usage':raw.get('usage'),'cost_usd':price(raw),'response_id':raw.get('id'),'model':raw.get('model')}


def api_key():
    if os.environ.get('OPENAI_API_KEY'):return os.environ['OPENAI_API_KEY']
    path=Path.home()/'.config/snippy/snippy.env'
    for line in path.read_text().splitlines():
        if line.startswith('OPENAI_API_KEY='):return line.split('=',1)[1].strip().strip('\"\'')
    raise RuntimeError('OPENAI_API_KEY unavailable')


def process(row,run,key):
    import requests
    vid=row['video_id']; path=run/'results'/f'{vid}.json'
    base={'video_id':vid,'input_hash':row['input_hash'],'assessed_at':now()}
    if row['protected_matches']:
        result={**base,'status':'preserved','protected_matches':row['protected_matches'],'cost_usd':0,'api_called':False}
        atomic(path,result);return result
    if not row['transcript']:
        result={**base,'status':'unassessed','error':'No stored transcript','cost_usd':0,'api_called':False}
        atomic(path,result);return result
    body=request_body(row); h=digest(body);raw_path=run/'responses'/f'{h}.json'
    if raw_path.exists():
        raw=json.loads(raw_path.read_text())
    else:
        for attempt in range(4):
            response=requests.post('https://api.openai.com/v1/responses',headers={'Authorization':'Bearer '+key},json=body,timeout=(15,300))
            if response.status_code==200:
                raw=response.json();atomic(raw_path,raw);break
            if response.status_code in (429,500,502,503,504) and attempt<3:
                time.sleep(min(30,2**(attempt+1)));continue
            raise RuntimeError(f'OpenAI {response.status_code}: {response.text[:300]}')
    result={**base,**classify(row,raw),'request_hash':h,'api_called':True}
    atomic(path,result);return result


def run_audit(run,limit,workers):
    key=api_key(); rows=[]
    for row in inputs(run):
        path=run/'results'/f"{row['video_id']}.json"
        if path.exists():
            old=json.loads(path.read_text())
            if old['input_hash']==row['input_hash'] and old['status']!='error':
                if row['protected_matches'] or not row['transcript'] or old.get('request_hash')==digest(request_body(row)):continue
        rows.append(row)
    # Materialize every bypass before model calls, even in a pilot run.
    bypass=[r for r in rows if r['protected_matches'] or not r['transcript']]
    for row in bypass:process(row,run,key)
    todo=[r for r in rows if not r['protected_matches'] and r['transcript']]
    if limit:todo=todo[:limit]
    print(json.dumps({'bypassed':len(bypass),'calls_pending':len(todo),'workers':workers}),flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures={pool.submit(process,row,run,key):row for row in todo}
        for i,future in enumerate(concurrent.futures.as_completed(futures),1):
            row=futures[future]
            try:r=future.result()
            except Exception as e:
                r={'video_id':row['video_id'],'input_hash':row['input_hash'],'status':'error','error':str(e),'assessed_at':now()}
                atomic(run/'results'/f"{row['video_id']}.json",r)
            print(json.dumps({'done':i,'total':len(todo),'id':row['video_id'],'status':r['status'],
                'score':r.get('assessment',{}).get('vitrupo_score'),'cost_usd':r.get('cost_usd'), 'error':r.get('error')}),flush=True)
    report(run)


def report(run):
    rows=[];counts={}; total_cost=0
    for row in inputs(run):
        path=run/'results'/f"{row['video_id']}.json"
        result=json.loads(path.read_text()) if path.exists() else {'status':'pending'}
        out=result.get('assessment',{}); m=out.get('best_moment',{})
        checks=result.get('evidence_checks',{})
        names=result.get('protected_matches',{})
        record={k:row.get(k) for k in ('video_id','title','publisher','speaker_source','url','published_at')}
        record.update({'status':result['status'],'protected_speakers':', '.join(names),'score':out.get('vitrupo_score'),
            'model_eligible':out.get('eligible'),'original':out.get('original'),
            'has_self_contained_ai_passage':out.get('has_self_contained_ai_passage'),'passage_reason':out.get('passage_reason'),'speaker':out.get('speaker'),
            'safety_fit':out.get('safety_fit'),'timeline_fit':out.get('timeline_fit'),
            'reason':out.get('reason') or result.get('error') or ('Automatic preserve exemption' if names else ''),
            'start_seconds':m.get('start_seconds'),'end_seconds':m.get('end_seconds'),'quote':m.get('quote'),'claim':m.get('claim'),
            'evidence_issues':', '.join(k for k,v in checks.items() if not v) if out.get('has_self_contained_ai_passage') else '',
            'cost_usd':price(result) if result.get('usage') else 0,'assessed_at':result.get('assessed_at'),
            'watch_moment':row['url']+('&' if '?' in row['url'] else '?')+'t='+str(max(0,int(m.get('start_seconds') or 0)))})
        rows.append(record);counts[result['status']]=counts.get(result['status'],0)+1
        total_cost+=result.get('cost_usd',0)
    order={'eligible':0,'review':1,'preserved':2,'no_passage':3,'not_eligible':4,'unassessed':5,'error':5,'pending':6}
    rows.sort(key=lambda r:(order[r['status']],-(r['score'] or 0),r['video_id']))
    for filename,subset in [('all-videos.csv',rows),('eligible-clips.csv',[r for r in rows if r['status']=='eligible']),
                            ('no-clipworthy-passage.csv',[r for r in rows if r['status']=='no_passage']),
                            ('preserved.csv',[r for r in rows if r['status']=='preserved']),
                            ('needs-review.csv',[r for r in rows if r['status'] in ('review','unassessed','error')])]:
        with (run/filename).open('w',newline='',encoding='utf-8-sig') as f:
            w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(subset)
    total_cost=sum(price(json.loads(p.read_text())) for p in (run/'responses').glob('*.json'))
    summary={'generated_at':now(),'unique_videos':len(rows),'counts':counts,'cost_usd':round(total_cost,4),
             'model':MODEL,'prompt_source':PROMPT_SOURCE,'protected_speakers':list(PROTECTED),
             'note':'Model triage of stored transcripts. Quotes/timestamps checked against text; audio/video and source identity not independently verified. No videos deleted or production scores changed.'}
    atomic(run/'summary.json',summary)
    atomic(run/'review-data.json',rows)
    template=(ROOT/'report.html').read_text()
    page=template.replace('__SUMMARY__',html.escape(json.dumps(summary,indent=2))).replace('__DATA__',json.dumps(rows,ensure_ascii=False).replace('<','\\u003c'))
    (run/'report.html').write_text(page,encoding='utf-8')
    print(json.dumps(summary),flush=True)
    return rows,summary


def verify(run):
    rows,summary=report(run)
    all_inputs=list(inputs(run)); ids={r['video_id'] for r in all_inputs}
    actual={p.stem for p in (run/'results').glob('*.json')}
    checks={'all_snapshot_videos_accounted_for':ids==actual,'no_failed_or_pending_calls':not any(summary['counts'].get(k,0) for k in ('error','pending')),
        'protected_metadata_never_called_or_rejected':True,'source_hashes_match':True,'snapshot_hashes_match':True,'full_transcript_request_hashes_match':True,
        'negative_decisions_consistent':True,'eligible_evidence_passes':True}
    for row in all_inputs:
        p=run/'results'/f"{row['video_id']}.json"
        if not p.exists():continue
        r=json.loads(p.read_text())
        checks['source_hashes_match'] &= r['input_hash']==row['input_hash']
        checks['snapshot_hashes_match'] &= digest({k:v for k,v in row.items() if k!='input_hash'})==row['input_hash']
        if r.get('api_called'):
            checks['full_transcript_request_hashes_match'] &= r['request_hash']==digest(request_body(row))
        if r['status']=='no_passage':
            checks['negative_decisions_consistent'] &= not r['assessment']['eligible'] and not r['assessment']['has_self_contained_ai_passage'] and not r['protected_matches']
        if row['protected_matches']:
            checks['protected_metadata_never_called_or_rejected'] &= r['status']=='preserved' and not r.get('api_called')
        if r['status']=='eligible':checks['eligible_evidence_passes'] &= all(r['evidence_checks'].values()) and r['assessment']['eligible'] and r['assessment']['original']
    receipt={'time':now(),'requested':f'Assess all non-exempt Snippy videos with full stored transcripts; preserve {len(PROTECTED)} named speakers.',
             'conducted':summary,'checks':checks,'missing_transcripts':summary['counts'].get('unassessed',0),
             'feedback_loop':'Not part of this one-time audit; no ranking rules modified.', 'passed':all(checks.values())}
    atomic(run/'verification.json',receipt)
    print(json.dumps(receipt,indent=2))
    return 0 if receipt['passed'] else 1


def main():
    ap=argparse.ArgumentParser();ap.add_argument('command',choices=['snapshot','run','report','verify'])
    ap.add_argument('--run-dir',type=Path,default=DEFAULT_RUN);ap.add_argument('--limit',type=int,default=0);ap.add_argument('--workers',type=int,default=12)
    a=ap.parse_args();a.run_dir.mkdir(parents=True,exist_ok=True)
    if a.command=='snapshot':snapshot(a.run_dir)
    elif a.command=='run':run_audit(a.run_dir,a.limit,a.workers)
    elif a.command=='report':report(a.run_dir)
    else:return verify(a.run_dir)
    return 0

if __name__=='__main__':raise SystemExit(main())
