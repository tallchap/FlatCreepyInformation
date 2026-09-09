#!/usr/bin/env python3
"""Auditable YouTube-first discovery. Extends the repository's YT/Brave/X actuators.

Origins: doom-research/app.py, youtube-research-server/shared.py,
twitter-research-server/app.py and custom-skills/x-video-sweep/sweep.py.
Search output is a review queue, never automatically a verified clip list.
Keys are environment-only. Raw results stay outside the public site directory.
"""
import argparse, concurrent.futures, datetime as dt, email.utils, json, os, re
import threading, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

NOW = dt.datetime.now(dt.timezone.utc)
LEDGER, LOCK, THROTTLES, LAST = [], threading.Lock(), {}, {}

def request(platform, endpoint, params, *, query_id, retries=2):
    headers = {}
    params = dict(params)
    if platform == 'youtube': params['key'] = os.environ['YOUTUBE_API_KEY']
    elif platform == 'twitter': headers['X-API-Key'] = os.environ['TWITTERAPI_KEY']
    else: headers['X-Subscription-Token'] = os.environ['BRAVE_API_KEY']
    for attempt in range(retries + 1):
        # One throttle per provider, including retries and concurrent calls.
        with LOCK: throttle = THROTTLES.setdefault(platform, threading.Lock())
        with throttle:
            interval = 5.5 if platform == 'twitter' else 1.1 if platform == 'brave' else .12
            time.sleep(max(0, LAST.get(platform, 0) + interval - time.monotonic()))
            LAST[platform] = time.monotonic()
        row = {'platform': platform, 'endpoint': endpoint, 'query_id': query_id,
               'attempt': attempt + 1, 'started_at': dt.datetime.now(dt.timezone.utc).isoformat()}
        with LOCK: LEDGER.append(row)
        try:
            req = urllib.request.Request(endpoint+'?'+urllib.parse.urlencode(params), headers=headers)
            with urllib.request.urlopen(req, timeout=35) as res:
                payload = json.load(res); row['status'] = res.status
            expected = 'tweets' if platform == 'twitter' else 'items' if platform == 'youtube' else None
            if not isinstance(payload, dict) or (expected and not isinstance(payload.get(expected), list)):
                row['error']='UnexpectedResponseShape'
                raise RuntimeError(f'{platform} returned no valid result list; not a successful empty search')
            row['returned'] = len(payload.get('tweets', payload.get('items', payload.get('results', payload.get('web', {}).get('results', [])))))
            return payload
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as exc:
            code = getattr(exc, 'code', None)
            row.update(status=code, error=type(exc).__name__)
            if attempt == retries or code not in (None, 429, 500, 502, 503, 504):
                raise RuntimeError(f'{platform} request failed: {type(exc).__name__} HTTP {code}') from None
            retry_after = getattr(exc, 'headers', {}).get('Retry-After', '')
            delay = float(retry_after) if str(retry_after).isdigit() else 2**(attempt+1)
            time.sleep(min(45, max(delay, 2)))

def canonical_youtube(url):
    try:
        p = urllib.parse.urlparse(url)
        host = p.netloc.lower().removeprefix('www.').removeprefix('m.')
        if host == 'youtu.be': vid = p.path.strip('/').split('/')[0]
        elif host == 'youtube.com':
            vid = urllib.parse.parse_qs(p.query).get('v', [''])[0]
            if not vid and p.path.startswith(('/shorts/', '/embed/', '/live/')): vid=p.path.split('/')[2]
        else: return None
        return vid if re.fullmatch(r'[A-Za-z0-9_-]{11}', vid) else None
    except (ValueError, IndexError): return None

def tweet_video(t):
    # Media and quoted-video handling from x-video-sweep/extract_video.
    for parent, kind in ((t, 'native'), (t.get('quoted_tweet') or {}, 'quoted')):
        for m in (parent.get('extendedEntities') or {}).get('media') or []:
            if m.get('type') == 'video':
                return {'kind': kind, 'source_post_id': str(parent.get('id', '')),
                        'duration_ms': (m.get('video_info') or {}).get('duration_millis'),
                        'thumbnail': m.get('media_url_https')}
    return None

def video_links(t):
    links = []
    for parent in (t, t.get('quoted_tweet') or {}):
        for u in (parent.get('entities') or {}).get('urls') or []:
            links.append(u.get('expanded_url') or u.get('expandedUrl') or u.get('url', ''))
        links.extend(re.findall(r'https?://[^\s<>]+', parent.get('text', '')))
    return sorted(set(v for u in links if (v := canonical_youtube(u))))

def relevance(t):
    """Conservative triage, not a replacement for transcript/source review."""
    text=t.get('text','')+' '+(t.get('quoted_tweet') or {}).get('text','')
    author=t.get('author') or {}
    identity=(author.get('userName','')+' '+author.get('name','')).lower().replace(' ','')
    if any(name in identity for name in ['wesroth','rileybrown','matthewbarnett','rowancheung']):
        return 'hold_original_interview_exception'
    if not re.search(r'\bAI\b|artificial intelligence|superintelligence|\bAGI\b|OpenAI|Anthropic|Cotra|Krueger|Kokotajlo|Yampolskiy|Tegmark|Bengio|Hinton|Helen Toner|Stuart Russell',text,re.I):
        return 'reject_no_ai_context'
    if not re.search(r'\bsafety\b|extinct|catastroph|takeover|alignment|misalign|\bcontrol\b|scheming|decep|\bpause\b|moratorium|superintelligence|warning shot|hugging face|rogue|guardrail|oversight|shutdown|shut down|dangerous|\brisk\b',text,re.I):
        return 'hold_ai_adjacent'
    return 'review_safety_video'

def youtube(q, index, after, cap=2):
    out=[]; token=''; seen_tokens=set(); pages=[]; stop='page_cap'
    qid=f'yt-{index}'
    for page in range(cap):
        params={'q':q, 'part':'snippet', 'type':'video', 'maxResults':50,
                'order':'relevance', 'pageToken':token, 'relevanceLanguage':'en',
                'videoDuration':'long'}
        # Keep the original long-video filter; source full talks, then clip moments.
        if after: params['publishedAfter']=after
        data=request('youtube','https://www.googleapis.com/youtube/v3/search',params,query_id=qid)
        batch=data.get('items',[]); out.extend(batch); token=data.get('nextPageToken','')
        pages.append({'page':page+1,'returned':len(batch),'has_next_page':bool(token)})
        if not token: stop='exhausted'; break
        if token in seen_tokens: stop='repeated_cursor'; break
        seen_tokens.add(token)
    return {'platform':'youtube','query_id':qid,'query':q,'after':after,'pages':pages,'stop_reason':stop,'results':out}

def brave(q,index,kind):
    data=request('brave',f'https://api.search.brave.com/res/v1/{kind}/search',
                 {'q':q,'count':20},query_id=f'brave-{kind}-{index}')
    return {'platform':'web' if kind=='web' else 'web_video','query_id':f'brave-{kind}-{index}',
            'query':q,'results':data.get('web',{}).get('results',[]) if kind=='web' else data.get('results',[])}

def twitter(q,index,mode,since,until,cap):
    query=f'{q} since:{since} until:{until} lang:en'; qid=f'x-{index}-{mode}-{since}'
    rows={}; pages=[]; cursor=''; seen=set(); stop='page_cap'
    for page in range(cap):
        data=request('twitter','https://api.twitterapi.io/twitter/tweet/advanced_search',
                     {'query':query,'queryType':mode,'cursor':cursor},query_id=qid)
        batch=data.get('tweets') or []; more=data.get('has_next_page',False); nxt=data.get('next_cursor')
        pages.append({'page':page+1,'returned':len(batch),'has_next_page':more})
        for t in batch:
            if t.get('id'): rows[str(t['id'])]=t
        if not more: stop='exhausted'; break
        if not nxt or nxt in seen: stop='missing_or_repeated_cursor'; break
        if not batch: stop='empty_page_with_more'; break
        seen.add(nxt); cursor=nxt
    return {'platform':'twitter','query_id':qid,'query':query,'mode':mode,'pages':pages,
            'stop_reason':stop,'results':list(rows.values())}

def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.tmp'); tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2));tmp.replace(path)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan',type=Path,default=Path(__file__).with_name('discovery-plan.json'))
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--platform',choices=['youtube-web','twitter'],required=True)
    p.add_argument('--max-pages',type=int,default=4)
    p.add_argument('--edition',default=str(NOW.date()),help='UTC edition date; defaults to today')
    args=p.parse_args()
    if not 1<=args.max_pages<=20: p.error('max-pages must be 1..20')
    cfg=json.loads(args.plan.read_text()); edition=dt.date.fromisoformat(args.edition)
    prior_edition=dt.date.fromisoformat(cfg['edition'])
    for key in ['web_queries','web_video_queries']:
        cfg[key]=[q.replace(prior_edition.strftime('%B %Y'),edition.strftime('%B %Y')) for q in cfg[key]]
    recent_after=str(edition-dt.timedelta(days=25))+'T00:00:00Z'
    until=str(edition+dt.timedelta(days=1)); since=str(edition-dt.timedelta(days=7))
    tasks=[]; results=[]
    if args.platform=='youtube-web':
        tasks.extend((youtube,(q,i,recent_after)) for i,q in enumerate(cfg['youtube_queries']))
        tasks.extend((youtube,(q,'archive-'+str(i),None,1)) for i,q in enumerate(cfg['youtube_archive_queries']))
        tasks.extend((brave,(q,i,'web')) for i,q in enumerate(cfg['web_queries']))
        tasks.extend((brave,(q,i,'videos')) for i,q in enumerate(cfg['web_video_queries']))
    else:
        tasks.extend((twitter,(q,i,mode,since,until,args.max_pages)) for i,q in enumerate(cfg['twitter_queries']) for mode in ('Latest','Top'))
    def perform(job):
        fn,values=job
        try: return fn(*values)
        except Exception as exc: return {'platform':fn.__name__,'query':values[0],'error':str(exc)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for r in pool.map(perform,tasks):
            results.append(r); write(args.output,{'started_at':NOW.isoformat(),'results':results,'ledger':LEDGER})
            print(r['platform'],r.get('query_id',''),len(r.get('results',[])),r.get('stop_reason',r.get('error','')),flush=True)
    # Split saturated Latest windows into daily intervals, within an explicit extra budget.
    refinements=0
    if args.platform=='twitter':
        capped=[r for r in results if r.get('mode')=='Latest' and r.get('stop_reason')=='page_cap'][:2]
        for parent in capped:
            idx=int(parent['query_id'].split('-')[1]); q=cfg['twitter_queries'][idx]
            for days_ago in range(3):
                d=edition-dt.timedelta(days=days_ago)
                r=perform((twitter,(q,f'{idx}-daily','Latest',str(d),str(d+dt.timedelta(days=1)),2)))
                r['refines']=parent['query_id']; results.append(r); refinements+=1
                write(args.output,{'started_at':NOW.isoformat(),'results':results,'ledger':LEDGER})
    metadata=[]
    if args.platform=='youtube-web':
        ids=set()
        for r in results:
            for item in r.get('results',[]):
                vid=item.get('id',{}).get('videoId') if isinstance(item.get('id'),dict) else canonical_youtube(item.get('url',''))
                if vid: ids.add(vid)
        ids=sorted(ids)
        for i in range(0,len(ids),50):
            try:
                data=request('youtube','https://www.googleapis.com/youtube/v3/videos',
                    {'part':'snippet,contentDetails,statistics','id':','.join(ids[i:i+50])},query_id='metadata-'+str(i//50))
                metadata.extend(data.get('items',[]))
            except RuntimeError as exc: results.append({'platform':'youtube_metadata','error':str(exc)})
    unique={str(t['id']):t for r in results if r['platform']=='twitter' for t in r.get('results',[]) if t.get('id')}
    queue=[]; rejected=[]
    for t in unique.values():
        media=tweet_video(t); links=video_links(t)
        if media or links:
            author=t.get('author') or {}
            triage=relevance(t)
            if triage!='review_safety_video':
                rejected.append({'id':str(t['id']),'reason':triage})
                continue
            queue.append({'id':str(t['id']),'author':author.get('userName'), 'text':t.get('text'),
                'url':t.get('twitterUrl') or t.get('url'), 'views':t.get('viewCount'),
                'likes':t.get('likeCount'),'reposts':t.get('retweetCount'),'published_at':t.get('createdAt'),
                'video':media,'youtube_ids':links,'triage':triage,'status':'source and speech verification required'})
    summary={'query_count':len(results),'requests':len(LEDGER),'successful_requests':sum(r.get('status')==200 for r in LEDGER),
             'returned':sum(r.get('returned',0) for r in LEDGER), 'unique_tweets':len(unique),
             'video_leads':len(queue),'youtube_metadata':len(metadata),'daily_refinements':refinements,
             'capped_queries':sum(r.get('stop_reason')=='page_cap' for r in results),
             'errors':sum(bool(r.get('error')) for r in results)}
    write(args.output,{'started_at':NOW.isoformat(),'finished_at':dt.datetime.now(dt.timezone.utc).isoformat(),
          'summary':summary,'results':results,'ledger':LEDGER,'youtube_metadata':metadata,'video_review_queue':queue,'held_or_rejected':rejected})
    print(json.dumps(summary),flush=True)

if __name__=='__main__': main()
