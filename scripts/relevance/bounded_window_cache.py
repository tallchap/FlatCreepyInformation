"""Validate existing bounded source windows for offline reuse; no network I/O."""
import json
from pathlib import Path
import time
import audit
from process_astra import require, sha


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def open_window(directory, input_root, _seen=None):
    started = time.monotonic()
    directory, input_root = Path(directory).resolve(), Path(input_root).resolve()
    seen = set(_seen or ())
    require(directory not in seen, 'Cache ancestry cycle')
    seen.add(directory)
    recipe, result, qa = [read(directory / n) for n in ('recipe.json', 'result.json', 'qa.json')]
    vid = recipe['candidate_id']
    manifest = read(input_root / 'manifest.json')
    row = next((row for row in manifest['candidates'] if row['candidate_id'] == vid), None)
    require(row is not None, 'Cache candidate is outside immutable manifest')
    packet_path = input_root / 'candidates' / (vid + '.json')
    packet = read(packet_path)
    require(audit.digest(packet) == row['packet_sha256'], 'Cache packet hash drift')
    forbidden = {row['video_id'] if isinstance(row, dict) else row for row in read(input_root / 'culled-ids.json')}
    require(vid not in forbidden, 'Culled candidate is forbidden in cache')
    require(vid == packet['candidate_id'] == result['candidate_id'], 'Cache candidate mismatch')
    require(recipe['source_input_hash'] == packet['source_input_hash'] == result['source_input_hash'], 'Cache source hash drift')
    obj = packet['gcs_object']
    revised = (directory / 'trim.json').exists() or result.get('metadata_only')
    if (directory / 'trim.json').exists():
        trim = read(directory / 'trim.json')
        parent = open_window(trim['parent_clip_dir'], input_root, seen)
        require(parent['media_sha256'] == trim['media_sha256'], 'Cache trim parent media drift')
        require(audit.digest(read(Path(trim['parent_clip_dir']) / 'recipe.json')) == trim['recipe_hash'], 'Cache trim parent recipe drift')
        require(str(trim['source_generation']) == str(obj['generation']), 'Cache trim generation drift')
        require(recipe.get('parent_media_sha256') == trim['media_sha256'], 'Cache revised recipe parent mismatch')
        if result.get('encoding_identity'):
            require(result.get('render_identity') == audit.digest({'trim_plan': trim, 'encoding': result['encoding_identity'], 'original_source': bool(result.get('original_source'))}), 'Cache trim encoding identity drift')
        source = parent['source_object']
    elif result.get('metadata_only'):
        matches = []
        for path in (input_root.parent / 'rendered').glob(vid + '-*/result.json'):
            raw = read(path)
            if raw.get('output_sha256') == result['output_sha256'] and path.parent.resolve() != directory:
                matches.append(path.parent)
        require(len(matches) == 1, 'Cache metadata-only source is absent or ambiguous')
        parent = open_window(matches[0], input_root, seen)
        require(audit.digest(read(matches[0] / 'recipe.json')) == audit.digest(read(directory / 'parent-recipe.json')), 'Cache metadata-only parent recipe drift')
        source = parent['source_object']
    else:
        source = read(directory / 'source.json')
    require(all(str(source.get(key)) == str(obj[key]) for key in ('bucket', 'name', 'generation', 'size')), 'Cache source object identity drift')
    require(str(result['source_generation']) == str(obj['generation']), 'Cache generation drift')
    encoding = result.get('encoding_identity', 'h264-crf18-slow-aac192-v1')
    identity = audit.digest(recipe) if revised else audit.digest({'recipe': recipe, 'generation': obj['generation'], 'encoding': encoding})
    require(result['recipe_hash'] == identity, 'Cache recipe/encoding identity drift')
    ranges = [{'start_seconds': e['start_seconds'], 'end_seconds': e['end_seconds']} for e in recipe['edits']]
    duration = sum(e['end_seconds'] - e['start_seconds'] for e in ranges)
    require(15 <= duration <= 240 and all(0 <= e['start_seconds'] < e['end_seconds'] <= packet['source_duration_seconds'] for e in ranges), 'Cache window is not bounded')
    required = ('video', 'audio', 'duration', 'native_dimensions', 'full_decode')
    require(all(qa.get('checks', {}).get(k) is True and result.get('automated_qa', {}).get(k) is True for k in required), 'Cache technical QA failed')
    if result.get('encoding_identity'):
        require(qa['checks'].get('native_fps') is True and result['automated_qa'].get('native_fps') is True, 'Cache native FPS QA missing')
    media = directory / 'clip.mp4'
    require(media.exists() and sha(media) == result['output_sha256'], 'Cache media hash drift')
    require(abs(result['duration_seconds'] - duration) < .3, 'Cache duration drift')
    key = audit.digest({'candidate_id': vid, 'source_input_hash': packet['source_input_hash'], 'object': obj, 'ranges': ranges, 'encoding': encoding})
    return {'schema_version': 'snippy-bounded-window-cache-v1', 'cache_key': key, 'candidate_id': vid,
        'directory': str(directory), 'media_path': str(media), 'media_sha256': result['output_sha256'],
        'packet_path': str(packet_path), 'packet_sha256': row['packet_sha256'],
        'manifest_sha256': sha(input_root / 'manifest.json'), 'cull_sha256': sha(input_root / 'culled-ids.json'),
        'source_input_hash': packet['source_input_hash'], 'source_object': obj, 'source_ranges': ranges,
        'duration_seconds': result['duration_seconds'], 'encoding_identity': encoding,
        'recipe_sha256': sha(directory / 'recipe.json'), 'qa_sha256': sha(directory / 'qa.json'),
        'result_sha256': sha(directory / 'result.json'), 'cache_hit': True, 'additional_gcs_bytes_read': 0,
        'validation_elapsed_seconds': time.monotonic() - started,
        'limitation': 'Reuses an already encoded bounded window; not a raw original source cache or editorial approval.'}
