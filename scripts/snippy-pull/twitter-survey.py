import os,json,time,urllib.request,urllib.parse,concurrent.futures,argparse,datetime
from pathlib import Path
root=Path(__file__).parent
today=datetime.datetime.now(datetime.timezone.utc).date()
parser=argparse.ArgumentParser(description='Paginated AI-safety X survey using the TwitterAPI.io discovery endpoint.')
parser.add_argument('--since',default=str(today-datetime.timedelta(days=3)))
parser.add_argument('--until',default=str(today+datetime.timedelta(days=1)))
parser.add_argument('--older-since',default=str(today-datetime.timedelta(days=14)))
parser.add_argument('--max-pages',type=int,default=6)
parser.add_argument('--output',type=Path,default=root/'expanded-twitter.json')
args=parser.parse_args()
if not 1<=args.max_pages<=100:parser.error('--max-pages must be 1..100')
for date in [args.since,args.until,args.older_since]:datetime.date.fromisoformat(date)
topics=['("AI safety" OR "AI extinction" OR "existential risk")','(superintelligence OR "AI takeover")','("AI alignment" OR "AI control" OR "loss of control")','("AI pause" OR "pause AI" OR "ban superintelligence" OR moratorium)','("AI" (deception OR blackmail OR shutdown OR bioweapons))','("Volker Turk" OR "Volker Türk" OR "Jakub Pachocki")','(from:ControlAI OR from:PauseAI OR from:ai_risks OR from:METR_Evals)','("AI" (interview OR podcast OR hearing OR testimony))']
tasks=[(q+f' since:{args.since} until:{args.until} lang:en',mode,args.max_pages) for q in topics for mode in ['Top','Latest']]
tasks += [(q+f' since:{args.older_since} until:{args.until} lang:en','Top',args.max_pages) for q in topics[:4]]
def run(task):
 q,mode,cap=task;cursor='';seen=set();rows=[];pages=[];seen_cursors=set();stop='page_cap'
 for page in range(cap):
  params={'query':q,'queryType':mode,'cursor':cursor};started=time.time()
  try:
   req=urllib.request.Request('https://api.twitterapi.io/twitter/tweet/advanced_search?'+urllib.parse.urlencode(params),headers={'X-API-Key':os.environ['TWITTERAPI_KEY']})
   with urllib.request.urlopen(req,timeout=30) as res:data=json.load(res)
  except Exception as exc:
   pages.append({'page':page+1,'error':type(exc).__name__,'status':getattr(exc,'code',None)});stop='request_error';break
  batch=data.get('tweets',[]);nxt=data.get('next_cursor');more=data.get('has_next_page',False)
  pages.append({'page':page+1,'returned':len(batch),'has_next_page':more,'next_cursor_present':bool(nxt),'started_at':started,'seconds':round(time.time()-started,2)})
  for t in batch:
   if t.get('id') and t['id'] not in seen:seen.add(t['id']);rows.append(t)
  if not more:stop='exhausted';break
  if not nxt or nxt in seen_cursors:stop='missing_or_repeated_cursor';break
  seen_cursors.add(nxt);cursor=nxt
 return {'query':q,'mode':mode,'pages':pages,'stop_reason':stop,'tweets':rows}
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for r in pool.map(run,tasks):
  results.append(r);args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps({'queries':results},ensure_ascii=False,indent=2))
  print(r['mode'],len(r['tweets']),len(r['pages']),r['stop_reason'],flush=True)
unique={t['id']:t for r in results for t in r['tweets']}
print('TOTAL',len(unique),'unique;',sum(p.get('returned',0) for r in results for p in r['pages']),'returned;',sum(len(r['pages']) for r in results),'requests',flush=True)
