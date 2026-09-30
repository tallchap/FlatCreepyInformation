#!/usr/bin/env python3
"""Verify canonical published pilot artifacts, independent reviews and live readback."""
import argparse, hashlib, html, json, sys
from pathlib import Path
import audit
ROOT = Path('.context/astra-clips')
def read(path): return json.loads(Path(path).read_text())
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    manifest = read(ROOT/'manifest.json'); canonical = read(ROOT/'canonical-clips.json')
    ids = read(ROOT/'pilot-manifest.json')['ids']; checks = {}; clips = []
    checks['two_complete_queues'] = manifest['counts'] == {'eligible':1116,'review':528} and all(sha(ROOT/f['path']) == f['sha256'] for f in manifest['files'])
    publications = {read(p)['video_id']:(p,read(p)) for p in (ROOT/'pilots').glob('*published.json')}
    astra = read(ROOT/'astra-final-verification.json')
    independent = {c.get('candidate_id',c.get('video_id')):c for c in astra['clips']}
    for vid in ids:
        try:
            folder = Path(canonical[vid]); result = read(folder/'result.json'); recipe = read(folder/'recipe.json'); qa = read(folder/'final-qa.json')
            pubpath, pub = publications[vid]; review = independent[vid]
            mh = sha(folder/'clip.mp4'); rh = audit.digest(recipe)
            checks[vid+'_artifacts'] = bool(pub['passed'] and qa['passed'] and all(qa['checks'].values()) and all(result['automated_qa'].values()) and mh == pub['media_sha256'] == qa['media_sha256'] == result['output_sha256'] and rh == pub['recipe_hash'] == qa['recipe_hash'])
            checks[vid+'_astra'] = review['verdict'].lower() == 'pass' and review['media_sha256'] == mh and review['recipe_hash'] == rh
            clips.append({'video_id':vid,'title':recipe['title'],'speaker':recipe['speaker'],'duration_seconds':result['duration_seconds'],'folder':str(folder.resolve().relative_to(ROOT.resolve())),'publication':str(pubpath.relative_to(ROOT)),'url':pub['gcs_url'],'snippet_id':pub['snippet_id'],'generation':pub['gcs_generation']})
        except (KeyError,OSError,ValueError) as e:
            checks[vid+'_artifacts'] = False
            clips.append({'video_id':vid,'error':str(e)})
    experiments = [read(p) for p in sorted(ROOT.glob('experiment-*-results.json'))]
    checks['repeated_luna_loops'] = len(experiments) >= 3 and all(e['all_complete'] and len(e['decisions']) == 5 for e in experiments)
    resume = read(ROOT/'experiment-1-resume.json')
    checks['zero_call_resume'] = resume['cache_hit'] and resume['api_calls_this_invocation'] == 0 and resume['new_cost_usd'] == 0
    checks['live_database_rows'] = checks['live_cloud_playback'] = False
    cloud = None
    if not args.offline and all('error' not in c for c in clips):
        import requests
        from google.cloud import bigquery
        client = audit.bq_client(); sids = [c['snippet_id'] for c in clips]
        job = client.query('SELECT * FROM `youtubetranscripts-429803.reptranscripts.snippets_auto` WHERE snippet_id IN UNNEST(@ids)',job_config=bigquery.QueryJobConfig(query_parameters=[bigquery.ArrayQueryParameter('ids','STRING',sids)]))
        rows = [dict(r) for r in job.result()]
        checks['live_database_rows'] = len(rows) == len(ids) and all(sum(r['snippet_id'] == c['snippet_id'] and r['gcs_url'] == c['url'] and r['provider'] == 'astra' and r['speaker'] == c['speaker'] for r in rows) == 1 for c in clips)
        playback = {}
        for c in clips:
            response = requests.get(c['url'],headers={'Range':'bytes=0-31'},timeout=30)
            playback[c['video_id']] = response.status_code == 206 and response.content == (ROOT/c['folder']/'clip.mp4').read_bytes()[:32] and response.headers.get('x-goog-generation') == c['generation']
        checks['live_cloud_playback'] = all(playback.values())
        cloud = {'time':audit.now(),'query_job_id':job.job_id,'query_bytes_billed':job.total_bytes_billed,'playback':playback}
    cost = read(ROOT/'cost-estimate.json') if (ROOT/'cost-estimate.json').exists() else None
    report = {'passed':all(checks.values()),'time':audit.now(),'requested':'Five published pilots, repeated Luna loops, independent Astra verification; twenty-clip calibration reported separately','conducted':f'{len(clips)} canonical pilot artifacts checked','checks':checks,'clips':clips,'cloud_verification':cloud,'cost_estimate':cost,'channels':{'render':'Mac FFmpeg with bounded GCS ranges','audio':'Local Whisper on exact media; no direct listening','visual':'Sampled contact sheets and full technical decode','models':'Separate paid Luna finalizer/verifier calls; Astra session subagent review','shadow':'Not used: queued job cancelled while workers busy','improver':'Twenty-clip calibration uses sealed Astra judgments, discrepancy review and versioned prompts; see calibration20'},'limitations':astra['limitations']}
    audit.atomic(ROOT/'verification.json',report)
    esc = html.escape; cards = []
    for c in clips:
        if 'error' in c: cards.append('<p>'+esc(c['error'])+'</p>'); continue
        folder = c['folder']
        cards.append(f'<article><h2>{esc(c["title"])}</h2><p>{esc(c["speaker"])} · {c["duration_seconds"]:.2f}s</p><video controls preload="metadata" src="{folder}/clip.mp4"></video><p><a href="{folder}/recipe.json">Recipe</a> · <a href="{folder}/final-qa.json">Luna QA</a> · <a href="{c["publication"]}">Publication receipt</a></p></article>')
    costhtml = '<p>See <a href="cost-estimate.md">cost estimate and assumptions</a>.</p>'
    if cost:
        t = cost['totals']; costhtml += f'<p>Estimated {t["candidates"]:,} available-source clips: ${t["one_time_usd"]:.2f} once + ${t["storage_usd_month"]:.2f}/month. Ten similar clips: ${t["ten_similar_clips_usd"]:.3f}. Estimate, not invoice.</p>'
    page = f'<!doctype html><meta charset="utf-8"><title>Snippy pilot verification</title><style>body{{font:17px system-ui;background:#14191f;color:#e5eaf0;max-width:1000px;margin:45px auto;padding:0 24px;line-height:1.5}}a{{color:#92cdfc}}article{{border-top:1px solid #46515f;margin-top:32px}}video{{width:100%;max-height:530px;background:black}}</style><h1>Five-clip pilot: {"PASS" if report["passed"] else "INCOMPLETE"}</h1><p>{esc(report["time"])}</p><p><a href="verification.json">Verification</a> · <a href="astra-final-verification.md">Independent Astra review</a> · <a href="calibration20/index.html">20-clip calibration</a></p><p><a href="01-ready-clips.md">1,116 ready</a> · <a href="02-recheck-clips.md">528 rechecks</a>. 362 missing sources excluded. Full production has not started.</p>{costhtml}<p>Review uses rendered-audio ASR and sampled stills. No claim of direct listening or continuous visual inspection.</p>{"".join(cards)}'
    (ROOT/'index.html').write_text(page)
    print(json.dumps({'passed':report['passed'],'checks':checks},indent=2))
    return 0 if report['passed'] else 1
if __name__ == '__main__': sys.exit(main())
