#!/usr/bin/env python3
"""Build a local media review page from the calibration evidence on disk."""
import html, json, os
from pathlib import Path
ROOT = Path('.context/astra-clips/calibration20')
def read(p): return json.loads(p.read_text())
def main():
    manifest = read(ROOT/'manifest.json'); cards=[]; esc=html.escape
    finals={}
    for p in sorted(ROOT.glob('luna-*/pipeline-results.json')):
        for d in read(p)['decisions']: finals[d['candidate_id']]=d
    paired=read(ROOT/'calibration.json') if (ROOT/'calibration.json').exists() else None
    pairs={r['candidate_id']:r for r in (paired or {}).get('rows',[])}
    for c in manifest['candidates']:
        vid=c['candidate_id']; rp=ROOT/'receipts'/f'{vid}.json'; receipt=read(rp) if rp.exists() else {}; d=finals.get(vid,{})
        folder=Path(d.get('media_path','')).parent if d else Path(receipt['directory']) if receipt.get('directory') else None
        status=esc(d.get('status',receipt.get('status','pending'))); comparison=pairs.get(vid,{})
        media=''
        if folder and (folder/'clip.mp4').exists():
            rel=os.path.relpath(folder,ROOT)
            media=f'<video controls preload="none" src="{rel}/clip.mp4"></video><p><a href="{rel}/recipe.json">Recipe</a> · <a href="{rel}/asr/clip.json">Rendered transcript</a> · <a href="{rel}/contact.jpg">Sampled frames</a></p>'
        cards.append(f'<article><h2>{esc(c["title"])}</h2><p>Wave {c["wave"]} · {c["lane"]} · {vid}</p><p>Luna: {status} · Astra blind: {esc(comparison.get("astra_blind_verdict","pending"))} · rounds: {d.get("attempts","—")}</p>{media}<p>{esc(comparison.get("astra_reason") or receipt.get("error", ""))}</p></article>')
    summary='<p>Review in progress. Status comes from saved receipts; pending is not a pass.</p>'
    if paired: summary='<pre>'+esc(json.dumps(paired['summary'],indent=2))+'</pre>'
    content=f'<!doctype html><meta charset="utf-8"><title>Luna / Astra calibration</title><style>body{{font:17px system-ui;background:#12171e;color:#e4ebf3;max-width:1000px;margin:40px auto;padding:0 22px;line-height:1.5}}a{{color:#9bd1ff}}article{{border-top:1px solid #445366;margin:30px 0;padding-top:12px}}video{{width:100%;max-height:540px;background:#000}}pre{{white-space:pre-wrap}}</style><h1>Luna / Astra calibration: {len(manifest['candidates'])} clips</h1><p>First ten train the rules; subsequent waves test fresh clips. Hard cap: 30 distinct clips including the original five. Missing GCS sources excluded. No calibration clips automatically published.</p><p><a href="manifest.json">Fixed sample</a> · <a href="astra-rubric.md">Astra rubric</a> · <a href="editorial.json">Initial editorial ledger</a> · <a href="calibration.md">Comparison report</a> · <a href="paired-results.csv">CSV</a> · <a href="../cost-estimate.md">Cost estimate</a></p>{summary}<p>Evidence-based automated QA uses rendered-audio ASR, sampled stills and technical decode. Direct audio listening and continuous visual inspection are not claimed. Small calibration sample; agreement with Astra is not proof of error-free production.</p>{"".join(cards)}'
    for name,label in [('calibration.md','Comparison report'),('paired-results.csv','CSV')]:
        if not (ROOT/name).exists(): content=content.replace(f'<a href="{name}">{label}</a>',label+' (pending)')
    (ROOT/'index.html').write_text(content)
if __name__=='__main__':main()
