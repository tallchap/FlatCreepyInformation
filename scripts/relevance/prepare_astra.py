#!/usr/bin/env python3
"""Create two portable Markdown work queues and bounded Astra pilot packets."""
import json,re,hashlib
from pathlib import Path
import audit
OUT=Path('.context/astra-clips');RUN=Path('.context/relevance')
PILOTS={'pilot-1':['6uwtlbPUjgo'],'pilot-2':['OPZxs6IXH00','MGJpR591oaM']}

def main():
    OUT.mkdir(exist_ok=True);(OUT/'candidates').mkdir(exist_ok=True);(OUT/'pilots').mkdir(exist_ok=True)
    contract=(Path(__file__).parent/'astra-review-contract.md').read_text()
    (OUT/'review-contract.md').write_text(contract)
    results={}
    for p in (RUN/'results').glob('*.json'):
        r=json.loads(p.read_text())
        if r['status'] in ('eligible','review'):results[r['video_id']]=r
    inventories=json.loads(Path('.context/cull-20260930/gcs-after/gcs-inventory/snippysaurus-clips-versions.json').read_text())['items']
    objects={r['name']:r for r in inventories};counts={'eligible':0,'review':0};packets={};sections={'eligible':[],'review':[]}
    for row in audit.inputs(RUN):
        vid=row['video_id']
        if vid not in results:continue
        result=results[vid];moment=result['assessment']['best_moment'];start=max(0,moment['start_seconds']-300);end=min(row['last_timestamp'],moment['end_seconds']+300)
        lines=[]
        for line in row['transcript'].splitlines():
            m=re.match(r'^\[([\d.]+)\] (.*)$',line)
            if m and start<=float(m[1])<=end:lines.append(line)
        packet={'candidate_id':vid,'lane':result['status'],'source_input_hash':row['input_hash'],'title':row['title'],'speaker_source':row['speaker_source'],'url':row['url'],'source_duration_seconds':row['last_timestamp'],'luna_proposal':moment,'luna_reason':result['assessment']['passage_reason'],'verification_failures':[k for k,v in result.get('evidence_checks',{}).items() if not v],'context_start_seconds':start,'context_end_seconds':end,'context_transcript':'\n'.join(lines),'gcs_object':objects.get('videos/'+vid+'.mp4'),'full_transcript_sha256':hashlib.sha256(row['transcript'].encode()).hexdigest()}
        packet['source_media_status']='gcs_available' if packet['gcs_object'] else 'source_resolution_required'
        packet['gcs_uri']=('gs://'+packet['gcs_object']['bucket']+'/'+packet['gcs_object']['name']) if packet['gcs_object'] else None
        audit.atomic(OUT/'candidates'/f'{vid}.json',packet);packets[vid]=packet
        section='\n## Candidate '+vid+'\n\n```json\n'+json.dumps({k:v for k,v in packet.items() if k not in ('context_transcript','gcs_object')},ensure_ascii=False,indent=2)+'\n```\n\n### Source transcript (absolute seconds; ±5 minutes)\n\n```text\n'+packet['context_transcript']+'\n```\n'
        sections[result['status']].append(section);counts[result['status']]+=1
    assert counts=={'eligible':1360,'review':646}
    for lane,name in [('eligible','01-ready-clips.md'),('review','02-recheck-clips.md')]:
        heading=f'# {counts[lane]:,} '+('ready candidates: independently review and approve/revise' if lane=='eligible' else 'candidates needing recheck: repair evidence and boundaries')+'\n\n'
        instructions='This is a work queue, not one giant model request. Process bounded groups of candidates, checkpoint JSON per ID, and maintain a coverage ledger. Every record includes its own source context. Continue until each record has a decision; never silently skip records. Candidates marked source_resolution_required can be reviewed from transcripts but must have an authorized source resolved before rendering; never assume every candidate has GCS footage. Only the three designated pilot candidates are executed in the current test. Full production requires the user to start that run.\n\n'
        (OUT/name).write_text(heading+instructions+contract+''.join(sections[lane]),encoding='utf-8')
    for name,ids in PILOTS.items():
        (OUT/'pilots'/f'{name}.md').write_text(contract+'\n\n# Pilot candidates\n\n'+''.join('\n```json\n'+json.dumps(packets[v],ensure_ascii=False,indent=2)+'\n```\n' for v in ids),encoding='utf-8')
    audit.atomic(OUT/'manifest.json',{'counts':counts,'source_media_counts':{status:sum(p['source_media_status']==status for p in packets.values()) for status in ['gcs_available','source_resolution_required']},'pilots':PILOTS,'context_seconds_each_side':300,'files':[{'path':name,'sha256':hashlib.sha256((OUT/name).read_bytes()).hexdigest(),'bytes':(OUT/name).stat().st_size} for name in ['01-ready-clips.md','02-recheck-clips.md']]})
    print(json.dumps(counts),'pilot packets ready')
if __name__=='__main__':main()
