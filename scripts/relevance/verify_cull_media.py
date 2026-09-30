#!/usr/bin/env python3
"""Verify full post-delete GCS inventory against the approved media plan."""
import json
import re
import cull


def verify():
    p=cull.OUT;plan=cull.read(p/'gcs-delete-plan.json');m=cull.read(p/'manifest.json')
    ids=set(m['ids']);rx=re.compile(r'(?<![A-Za-z0-9_-])('+'|'.join(re.escape(v) for v in ids)+r')(?![A-Za-z0-9_-])')
    after=p/'gcs-after';access=cull.read(after/'gcs-access.json')
    keys=lambda rows:{(r['bucket'],r['name'],r['generation']) for r in rows}
    objects=[];original=[];statuses=[]
    for root,collection in [(p,original),(after,objects)]:
        for f in (root/'gcs-inventory').glob('*.json'):
            d=cull.read(f);statuses.append(d['status'])
            collection.extend({**r,'inventory_state':'soft' if f.name.endswith('-soft.json') else 'versions'} for r in d['items'])
    expected=keys(plan['objects']);left=expected&keys(objects)
    hashes={(r.get('md5Hash'),r['size']) for r in plan['objects'] if r.get('md5Hash')}
    matches=[]
    for r in objects:
        is_media=r.get('contentType','').startswith(('video/','audio/')) or r['name'].lower().endswith(('.mp4','.mov','.mkv','.webm','.mp3','.wav','.m4a','.avi','.ts'))
        if is_media and (rx.search(json.dumps({'name':r['name'],'metadata':r.get('metadata',{})})) or (r.get('md5Hash'),r.get('size')) in hashes):matches.append(r)
    before_buckets={r['name'] for r in cull.read(p/'gcs-buckets.json')};after_buckets={r['name'] for r in cull.read(after/'gcs-buckets.json')}
    soft_buckets=cull.read(p/'gcs-soft-deleted-buckets.json')
    restored=all(cull.read(p/f'gcs-policy-original-{b}.json').get('softDeletePolicy',{}).get('retentionDurationSeconds','0')==cull.read(p/f'gcs-policy-restored-{b}.json').get('softDeletePolicy',{}).get('retentionDurationSeconds','0') for b in plan['buckets'])
    checks={'all_projects_accessible':all(r['status']==200 for r in access),'all_bucket_inventories_succeeded':all(v==200 for v in statuses),
        'all_buckets_rechecked':before_buckets==after_buckets,'no_soft_deleted_buckets':all(r['status']==200 and not r['response'].get('items') for r in soft_buckets),
        'exact_planned_generations_absent':not left,'no_matching_live_old_or_soft_deleted_copies':not matches,
        'non_target_generations_unchanged':keys(objects)==keys(original)-expected,'bucket_soft_delete_policy_restored':restored,
        'text_archive_verified':cull.read(p/'archive-verification.json')['passed'] and cull.read(p/'local-verification.json')['passed']}
    receipt={'time':cull.audit.now(),'passed':all(checks.values()),'checks':checks,'projects_checked':len(access),'buckets_checked':len(after_buckets),
        'deleted_media_objects':len(plan['objects']),'deleted_media_bytes':plan['media_bytes'],'video_ids_with_media':len({v for r in plan['objects'] for v in r['matched_ids']}),
        'matching_objects_remaining':len(matches),'media_downloaded_or_archived':False,
        'matching_method':plan['method'],'scope':'Google Cloud Storage in all projects visible to the authenticated Google account. Other providers are outside this account inventory.'}
    cull.audit.atomic(p/'gcs-verification.json',receipt);print(json.dumps(receipt,indent=2))
    if not receipt['passed']:raise ValueError('Storage verification failed')

if __name__=='__main__':verify()
