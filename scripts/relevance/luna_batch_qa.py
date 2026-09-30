#!/usr/bin/env python3
"""Batch rendered clips through Luna; hash-bound, bounded local QA feedback loop.

prepare never calls an API; review makes one resumable paid Responses request.
normalize accepts an existing raw response. trim executes a validated local trim.
Nothing uploads, publishes, writes a database, or modifies original footage.
"""
import argparse
import base64
import copy
import hashlib
import json
import math
import shutil
from pathlib import Path
import subprocess
import sys
import time

import audit
from process_astra import require, sha, probe, run

PROMPT = Path(__file__).with_name('luna-batch-qa-prompt.txt')
VERIFIER_PROMPT = Path(__file__).with_name('luna-batch-verifier-prompt.txt')
MAX_PASSES = 5
IDENTITIES = ['candidate_id', 'source_input_hash', 'media_sha256', 'recipe_hash', 'evidence_hash']
PROPS = {'candidate_id': {'type': 'string'}}
PROPS['retained_speaker'] = {'type': 'string'}
PROPS['final_title'] = {'type': 'string'}
PROPS['final_description'] = {'type': 'string'}
PROPS.update(status={'type': 'string', 'enum': ['approve', 'adjust', 'review', 'reject']}, reason={'type': 'string'}, preserves_meaning={'type': 'boolean'}, keep_start_seconds={'type': ['number', 'null']}, keep_end_seconds={'type': ['number', 'null']})
for key in ('picture_status', 'dialogue_status', 'boundaries_status', 'metadata_status'):
    PROPS[key] = {'type': 'string', 'enum': ['pass', 'fail', 'uncertain']}
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['decisions'], 'properties': {'decisions': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': list(PROPS), 'properties': PROPS}}}}


def read(path):
    return json.loads(Path(path).read_text())


def words_from(asr):
    words = asr.get('words') or [w for segment in asr.get('segments', []) for w in segment.get('words', [])]
    result = []
    previous = -1
    for word in words:
        start, end = word.get('start'), word.get('end')
        require(all(type(v) in (int, float) and math.isfinite(v) for v in (start, end)), 'ASR missing finite word timings')
        require(0 <= start <= end and start >= previous, 'ASR words are not in time order')
        text = word.get('word', word.get('text', ''))
        require(isinstance(text, str) and text.strip(), 'ASR word text missing')
        result.append({'start': start, 'end': end, 'text': text.strip()})
        previous = start
    return result


def package(clip_dir, packets, image=None):
    clip_dir = Path(clip_dir).resolve()
    result, recipe, qa = (read(clip_dir / f) for f in ('result.json', 'recipe.json', 'qa.json'))
    video, asr_path = clip_dir / 'clip.mp4', clip_dir / 'asr/clip.json'
    media_hash = sha(video)
    require(media_hash == result['output_sha256'], 'Media hash drift')
    vid = result['candidate_id']
    packet_path = (Path(packets) / f'{vid}.json').resolve()
    packet = read(packet_path)
    require(recipe['candidate_id'] == vid and recipe['source_input_hash'] == packet['source_input_hash'] == result['source_input_hash'], 'Source/recipe identity drift')
    require(str(result['source_generation']) == str(packet['gcs_object']['generation']), 'Source generation drift')
    words = words_from(read(asr_path)) if asr_path.exists() else []
    binding = clip_dir / 'asr/evidence.json'
    if binding.exists():
        bound = read(binding)
        require(bound['media_sha256'] == media_hash and bound['asr_sha256'] == sha(asr_path), 'ASR binding drift')
    import re
    context = []
    for line in packet['context_transcript'].splitlines():
        m = re.match(r'^\[([\d.]+)\]', line)
        if m and any(e['start_seconds'] - 30 <= float(m[1]) <= e['end_seconds'] + 30 for e in recipe['edits']):
            context.append(line)
    checks = qa.get('checks', {})
    technical = bool(checks) and all(v is True for v in checks.values())
    image = Path(image).resolve() if image else ((clip_dir / 'contact.jpg') if (clip_dir / 'contact.jpg').exists() else None)
    obj = {'candidate_id': vid, 'source_input_hash': packet['source_input_hash'], 'source_generation': result['source_generation'], 'media_sha256': media_hash, 'recipe_hash': audit.digest(recipe), 'recipe': recipe, 'duration_seconds': result['duration_seconds'], 'asr_words': words, 'asr_sha256': sha(asr_path) if words else None, 'asr_provenance': 'independent rendered-audio ASR; words are not original caption verbatim', 'source_caption_context': '\n'.join(context), 'automated_qa': checks, 'technical_pass': technical, 'image_sha256': sha(image) if image else None, 'attempt': 0}
    obj['image_evidence_format'] = 'Contact sheet of sampled video frames; its grid is a review artifact, not the source layout. Repeated static graphics may be native podcast artwork.'
    obj['source_speaker_evidence'] = {'packet_path': str(packet_path), 'packet_sha256': sha(packet_path), 'candidate_id': vid, 'source_input_hash': packet['source_input_hash'], 'source_generation': str(packet['gcs_object']['generation']), 'speaker_labels': [packet['speaker_source']] if isinstance(packet.get('speaker_source'), str) and packet['speaker_source'].strip() else [], 'caption_speaker_labels': sorted(set(re.findall(r'^\[[\d.]+\]\s*\[([^\]]+)\]', packet['context_transcript'], re.MULTILINE))), 'limitation': 'Source-level identities and caption labels are evidence to assess; they do not by themselves prove who speaks this retained passage.'}
    obj['evidence_hash'] = audit.digest(obj)
    return {'evidence': obj, 'clip_dir': str(clip_dir), 'image_path': str(image) if image else None}


def model_evidence(value):
    if isinstance(value, list):
        return [model_evidence(item) for item in value]
    if isinstance(value, dict):
        return {key: model_evidence(item) for key, item in value.items() if not key.endswith(('_hash', '_sha256')) and key != 'source_generation'}
    return value


def bind_request(body, packages):
    body['metadata'] = {'qa_schema': 'snippy-luna-batch-qa-v2', 'batch_evidence_hash': audit.digest([p['evidence'] for p in packages])}
    body['metadata']['request_fingerprint'] = audit.digest(body)
    return body


def build_request(packages):
    require(1 <= len(packages) <= 8, 'Batch must contain 1–8 clips')
    ids = [p['evidence']['candidate_id'] for p in packages]
    require(len(ids) == len(set(ids)), 'Duplicate candidates')
    content = []
    for p in packages:
        content.append({'type': 'input_text', 'text': json.dumps(model_evidence(p['evidence']), ensure_ascii=False)})
        if p['image_path']:
            data = Path(p['image_path']).read_bytes()
            require(hashlib.sha256(data).hexdigest() == p['evidence']['image_sha256'], 'Image hash drift')
            require(len(data) <= 8 * 1024 * 1024, 'Contact sheet exceeds 8 MiB')
            mime = 'image/png' if data.startswith(b'\x89PNG') else 'image/jpeg'
            content.append({'type': 'input_image', 'image_url': f'data:{mime};base64,' + base64.b64encode(data).decode(), 'detail': 'low'})
    return bind_request({'model': 'gpt-6-luna', 'instructions': PROMPT.read_text(), 'input': [{'role': 'user', 'content': content}], 'text': {'format': {'type': 'json_schema', 'name': 'snippy_luna_batch_qa_v1', 'schema': SCHEMA, 'strict': True}}, 'max_output_tokens': 10000}, packages)


def recheck(p):
    evidence, directory = p['evidence'], Path(p['clip_dir'])
    require(sha(directory / 'clip.mp4') == evidence['media_sha256'], 'Media hash drift')
    require(audit.digest(read(directory / 'recipe.json')) == evidence['recipe_hash'], 'Recipe hash drift')
    require(read(directory / 'qa.json').get('checks', {}) == evidence['automated_qa'], 'Technical QA evidence drift')
    if p.get('image_path'):
        require(sha(p['image_path']) == evidence['image_sha256'], 'Contact sheet hash drift')
    if evidence['asr_sha256']:
        require(sha(directory / 'asr/clip.json') == evidence['asr_sha256'], 'ASR hash drift')
    if p.get('current_render_package'):
        recheck(p['current_render_package'])
        require(evidence['current_cut']['media_sha256'] == p['current_render_package']['evidence']['media_sha256'], 'Current cut binding drift')
    verify_source_speakers(evidence.get('source_speaker_evidence'), read(directory / 'recipe.json'), read(directory / 'result.json'))
    expected = dict(evidence)
    digest = expected.pop('evidence_hash')
    require(audit.digest(expected) == digest, 'Evidence hash drift')


def verify_source_speakers(binding, recipe, result):
    if binding is None:
        return []
    path = Path(binding['packet_path'])
    require(path.is_file() and sha(path) == binding['packet_sha256'], 'Source speaker evidence hash drift')
    packet = read(path)
    require(binding['candidate_id'] == packet['candidate_id'] == recipe['candidate_id'] == result['candidate_id'], 'Source speaker candidate mismatch')
    require(binding['source_input_hash'] == packet['source_input_hash'] == recipe['source_input_hash'] == result['source_input_hash'], 'Source speaker input hash mismatch')
    require(str(binding['source_generation']) == str(packet['gcs_object']['generation']) == str(result['source_generation']), 'Source speaker generation mismatch')
    labels = [packet['speaker_source']] if isinstance(packet.get('speaker_source'), str) and packet['speaker_source'].strip() else []
    require(binding['speaker_labels'] == labels, 'Source speaker labels altered')
    return labels


def speaker_labels(evidence):
    return [evidence['recipe']['speaker']] + (evidence.get('source_speaker_evidence') or {}).get('speaker_labels', [])


def validate_speaker(speaker, provided):
    import re
    require(isinstance(speaker, str) and len(speaker.strip()) >= 3, 'Retained speaker label required')
    labels = [provided] if isinstance(provided, str) else provided
    def supported(part):
        normalized = ' '.join(part.split()).casefold()
        # An explicitly unknown role asserts no personal identity. Anchor the
        # whole phrase so an invented name cannot hide after an anonymous role.
        anonymous = re.fullmatch(r'(?:an? |the )?(?:unidentified|unknown|unnamed) (?:speaker|interviewer|moderator|panelist)(?:s|\(s\))?', normalized)
        return bool(anonymous) or (len(normalized) >= 3 and normalized not in ('and', 'the', 'with') and any(normalized in label.casefold() for label in labels))
    require(supported(speaker) or all(supported(part) for part in re.split(r'\s+(?:and|&)\s+|[,;]', speaker)), 'Speaker must be a retained subset of provided speaker labels, not an invented name')
    return speaker.strip()


def validate_publication_metadata(title, description):
    require(isinstance(title, str) and 1 <= len(title.strip()) <= 240, 'Final title must be nonempty and at most 240 characters')
    require(isinstance(description, str) and 1 <= len(description.strip()) <= 4000, 'Final description must be nonempty and at most 4000 characters')
    return title.strip(), description.strip()


def trim_plan(evidence, start, end, speaker=None, final_title=None, final_description=None):
    speaker = validate_speaker(speaker or evidence['recipe']['speaker'], speaker_labels(evidence))
    final_title, final_description = validate_publication_metadata(final_title if final_title is not None else evidence['recipe']['title'], final_description if final_description is not None else evidence['recipe']['reason'])
    require(all(type(v) in (int, float) and math.isfinite(v) for v in (start, end)), 'Trim timestamps must be finite')
    require(0 <= start < end <= evidence['duration_seconds'] and 15 <= end - start <= 240, 'Trim outside existing media or duration bounds')
    require(start > 0 or end < evidence['duration_seconds'] or evidence.get('current_cut'), 'Adjustment must trim or restore an earlier cut')
    words = evidence['asr_words']
    require(start in {w['start'] for w in words} and end in {w['end'] for w in words}, 'Trim must align exactly to ASR word boundaries')
    retained = [w for w in words if start <= w['start'] and w['end'] <= end]
    require(retained and not any(w['start'] < start < w['end'] or w['start'] < end < w['end'] for w in words), 'Trim cuts through an ASR word')
    selected_start, selected_end = start, end
    # ASR boundaries are estimates. Keep modest acoustic handles only inside
    # gaps: never include an excluded neighboring word according to the evidence.
    prior_end = max((w['end'] for w in words if w['end'] <= start and w not in retained), default=0)
    next_start = min((w['start'] for w in words if w['start'] >= end and w not in retained), default=evidence['duration_seconds'])
    left_handle = min(.12, max(0, start - prior_end) / 2)
    right_handle = min(.15, max(0, next_start - end) / 2, max(0, 240 - (end - start) - left_handle))
    left_handle = min(left_handle, max(0, 240 - (end - start)))
    start, end = round(start - left_handle, 6), round(end + right_handle, 6)
    mapped, offset = [], 0
    for edit in evidence['recipe']['edits']:
        length = edit['end_seconds'] - edit['start_seconds']
        lo, hi = max(start, offset), min(end, offset + length)
        if lo < hi:
            mapped.append({'start_seconds': edit['start_seconds'] + lo - offset, 'end_seconds': edit['start_seconds'] + hi - offset})
        offset += length
    require(abs(sum(e['end_seconds'] - e['start_seconds'] for e in mapped) - (end - start)) < 0.05, 'Trim exceeds recipe timeline')
    return {'schema_version': 'snippy-luna-trim-v1', **{k: evidence[k] for k in IDENTITIES}, 'source_generation': evidence['source_generation'], 'asr_sha256': evidence['asr_sha256'], 'source_speaker_evidence': evidence.get('source_speaker_evidence'), 'retained_speaker': speaker, 'final_title': final_title, 'final_description': final_description, 'keep_start_seconds': start, 'keep_end_seconds': end, 'selected_word_start_seconds': selected_start, 'selected_word_end_seconds': selected_end, 'boundary_handles': {'opening_seconds': round(selected_start - start, 6), 'closing_seconds': round(end - selected_end, 6), 'policy': 'up to 120ms opening and 150ms closing, at most half the ASR gap; no neighboring words'}, 'source_ranges': mapped, 'retained_asr_words': retained, 'transcript': ' '.join(w['text'] for w in retained), 'transcript_provenance': evidence['asr_provenance'], 'attempt': evidence.get('attempt', 0) + 1, 'restores_original_range': bool(evidence.get('current_cut'))}


def normalize(raw, packages, output, request=None):
    import jsonschema
    require(isinstance(request, dict), 'Exact persisted request required for response binding')
    persisted = Path(output) / 'request.json'
    require(persisted.exists() and audit.digest(read(persisted)) == audit.digest(request), 'Persisted request mismatch')
    expected_metadata = request.get('metadata', {})
    require(expected_metadata.get('qa_schema') == 'snippy-luna-batch-qa-v2', 'Response binding schema mismatch')
    require(expected_metadata.get('batch_evidence_hash') == audit.digest([p['evidence'] for p in packages]), 'Request batch evidence binding mismatch')
    fingerprint_body = copy.deepcopy(request)
    fingerprint = fingerprint_body['metadata'].pop('request_fingerprint', None)
    require(fingerprint == audit.digest(fingerprint_body), 'Request fingerprint mismatch')
    require(raw.get('metadata') == expected_metadata, 'Response metadata binding mismatch')
    require(raw.get('status') == 'completed', 'Responses request not completed')
    text = ''.join(c.get('text', '') for item in raw.get('output', []) if item.get('type') == 'message' for c in item.get('content', []) if c.get('type') == 'output_text')
    data = json.loads(text)
    jsonschema.validate(data, SCHEMA)
    decisions = data['decisions']
    expected = {p['evidence']['candidate_id']: p for p in packages}
    ids = [d['candidate_id'] for d in decisions]
    require(len(ids) == len(set(ids)) and set(ids) == set(expected), 'Missing, extra or duplicate candidate decisions')
    normalized = []
    # Validate everything before writing any executable action.
    pending = []
    for decision in decisions:
        p = expected[decision['candidate_id']]
        recheck(p)
        evidence = p['evidence']
        require(decision['reason'].strip(), 'Decision reason required')
        decision = {**copy.deepcopy(decision), **{key: evidence[key] for key in IDENTITIES}}
        try:
            decision['final_title'], decision['final_description'] = validate_publication_metadata(decision['final_title'], decision['final_description'])
            decision['retained_speaker'] = validate_speaker(decision['retained_speaker'], speaker_labels(evidence))
        except ValueError as exc:
            # Bad proposed metadata is a candidate-level repair request, not a
            # reason to lose valid neighboring decisions or relax source identity.
            normalized.append({**decision, 'status': 'review', 'keep_start_seconds': None, 'keep_end_seconds': None, 'action_validation_error': 'Invalid proposed metadata: ' + str(exc), 'reason': decision['reason'] + ' [Invalid proposed metadata; media and recipe unchanged: ' + str(exc) + ']', 'attempt': evidence['attempt'], 'automatic_release_eligible': False, 'published': False})
            continue
        status = decision['status']
        action = None
        if status == 'adjust':
            try:
                require(decision['preserves_meaning'], 'Trim must preserve meaning')
                action = trim_plan(evidence, decision['keep_start_seconds'], decision['keep_end_seconds'], decision['retained_speaker'], decision['final_title'], decision['final_description'])
            except ValueError as exc:
                decision.update(status='review', keep_start_seconds=None, keep_end_seconds=None, action_validation_error=str(exc), reason=decision['reason'] + ' [Invalid proposed edit; media unchanged: ' + str(exc) + ']')
            if evidence['attempt'] >= MAX_PASSES or not evidence['technical_pass']:
                decision.update(status='review', reason=decision['reason'] + ' [Automatic guard: retry exhausted or technical failure.]')
                action = None
        else:
            require(decision['keep_start_seconds'] is None and decision['keep_end_seconds'] is None, 'Only adjust may contain a trim')
        if status == 'approve' and (not evidence['technical_pass'] or not evidence['asr_words'] or not evidence['image_sha256'] or not decision['preserves_meaning'] or any(decision[k] != 'pass' for k in ('picture_status', 'dialogue_status', 'boundaries_status', 'metadata_status'))):
            decision.update(status='review', reason=decision['reason'] + ' [Automatic guard: missing or failed verification evidence.]')
        if request['instructions'] == VERIFIER_PROMPT.read_text() and decision['status'] == 'approve' and decision['retained_speaker'] != evidence['recipe']['speaker']:
            decision.update(status='review', reason=decision['reason'] + ' [Stored speaker metadata does not match retained speaker.]')
        record = {**decision, 'attempt': evidence['attempt'], 'automatic_release_eligible': decision['status'] == 'approve', 'published': False}
        if action:
            action.update(parent_clip_dir=p['clip_dir'], reason=decision['reason'])
            path = Path(output) / f"{decision['candidate_id']}.trim.json"
            pending.append((path, action))
            record['trim_path'] = str(path.resolve())
            record['next_command'] = [sys.executable, str(Path(__file__).resolve()), 'trim', '--trim-plan', str(path.resolve()), '--output', str((Path(output) / 'trimmed').resolve())]
        normalized.append(record)
    for path, action in pending:
        audit.atomic(path, action)
    result = {'schema_version': 'snippy-luna-batch-qa-v1', 'created_at': audit.now(), 'response_id': raw.get('id'), 'usage': raw.get('usage'), 'cost_usd': audit.price(raw), 'decisions': normalized, 'evidence_limitations': 'ASR plus sampled pictures; no claim of human listening or complete-frame review'}
    audit.atomic(Path(output) / 'results.json', result)
    return result


def execute_trim(plan_path, output, whisper_python=None):
    started = time.monotonic()
    plan = read(plan_path)
    require(plan['schema_version'] == 'snippy-luna-trim-v1' and 1 <= plan['attempt'] <= MAX_PASSES, 'Trim retry budget exceeded')
    directory = Path(plan['parent_clip_dir'])
    parent_attempt = read(directory / 'trim.json')['attempt'] if (directory / 'trim.json').exists() else 0
    require(plan['attempt'] == parent_attempt + 1, 'Trim ancestry/attempt mismatch')
    require(sha(directory / 'clip.mp4') == plan['media_sha256'], 'Parent media drift')
    recipe = read(directory / 'recipe.json')
    require(audit.digest(recipe) == plan['recipe_hash'], 'Parent recipe drift')
    asr_path = directory / 'asr/clip.json'
    require(sha(asr_path) == plan['asr_sha256'], 'ASR evidence drift')
    result = read(directory / 'result.json')
    verify_source_speakers(plan.get('source_speaker_evidence'), recipe, result)
    evidence = {**{k: plan[k] for k in IDENTITIES}, 'source_generation': plan['source_generation'], 'asr_sha256': plan['asr_sha256'], 'recipe': recipe, 'duration_seconds': result['duration_seconds'], 'asr_words': words_from(read(asr_path)), 'asr_provenance': plan['transcript_provenance'], 'attempt': parent_attempt, 'current_cut': plan.get('restores_original_range', False), 'source_speaker_evidence': plan.get('source_speaker_evidence')}
    expected = trim_plan(evidence, plan.get('selected_word_start_seconds', plan['keep_start_seconds']), plan.get('selected_word_end_seconds', plan['keep_end_seconds']), plan.get('retained_speaker'), plan.get('final_title'), plan.get('final_description'))
    if 'source_speaker_evidence' not in plan:
        expected.pop('source_speaker_evidence', None)  # Legacy plans retain their original hash/cache identity.
    require(all(plan[k] == v for k, v in expected.items()), 'Trim plan altered after validation')
    out = Path(output) / f"{plan['candidate_id']}-{audit.digest(plan)[:20]}"
    out.mkdir(parents=True, exist_ok=True)
    media = out / 'clip.mp4'
    if (out / 'result.json').exists():
        cached = read(out / 'result.json')
        require(sha(media) == cached['output_sha256'], 'Cached trim corrupt')
        return cached
    duration = plan['keep_end_seconds'] - plan['keep_start_seconds']
    run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', str(plan['keep_start_seconds']), '-i', str(directory / 'clip.mp4'), '-t', str(duration), '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(media)], out / 'trim.log')
    qa = probe(media, out / 'probe.log')
    source_qa = read(directory / 'qa.json')['ffprobe']
    video = next((s for s in qa['streams'] if s['codec_type'] == 'video'), {})
    source_video = next(s for s in source_qa['streams'] if s['codec_type'] == 'video')
    checks = {'video': bool(video), 'audio': any(s['codec_type'] == 'audio' for s in qa['streams']), 'native_dimensions': (video.get('width'), video.get('height')) == (source_video['width'], source_video['height']), 'duration': abs(float(qa['format']['duration']) - duration) < .3}
    run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-i', str(media), '-f', 'null', '-'], out / 'decode.log')
    checks['full_decode'] = True
    audit.atomic(out / 'qa.json', {'checks': checks, 'ffprobe': qa})
    require(all(checks.values()), 'Trim technical QA failed')
    audit.atomic(out / 'parent-recipe.json', recipe)
    revised = copy.deepcopy(recipe)
    revised.update(speaker_evidence=plan.get('source_speaker_evidence'), decision='revise', speaker=plan['retained_speaker'], title=plan['final_title'], reason=plan['final_description'], edit_notes='', transcript_provenance=plan['transcript_provenance'], timing_evidence_sha256=plan['asr_sha256'], parent_media_sha256=plan['media_sha256'])
    revised_edits, offset = [], 0
    for edit in recipe['edits']:
        length = edit['end_seconds'] - edit['start_seconds']
        lo, hi = max(plan['keep_start_seconds'], offset), min(plan['keep_end_seconds'], offset + length)
        if lo < hi:
            retained = [w['text'] for w in plan['retained_asr_words'] if lo <= w['start'] and w['end'] <= hi]
            revised_edits.append({'start_seconds': edit['start_seconds'] + lo - offset, 'end_seconds': edit['start_seconds'] + hi - offset, 'transcript': ' '.join(retained)})
        offset += length
    revised['edits'] = revised_edits
    audit.atomic(out / 'recipe.json', revised)
    audit.atomic(out / 'trim.json', plan)
    trimmed = {**result, 'clip_path': str(media.resolve()), 'output_sha256': sha(media), 'duration_seconds': float(qa['format']['duration']), 'output_bytes': media.stat().st_size, 'automated_qa': checks, 'attempt': plan['attempt'], 'recipe_hash': audit.digest(revised), 'elapsed_seconds': time.monotonic() - started, 'additional_gcs_bytes_read': 0, 'transfer_note': 'Parent transfer receipt retained; this local trim fetched zero additional GCS bytes', 'source_ranges': plan['source_ranges'], 'uploaded': False, 'database_written': False, 'human_picture_and_dialogue_review': 'pending', 'created_at': audit.now()}
    if whisper_python:
        (out / 'asr').mkdir(exist_ok=True)
        run([whisper_python, '-m', 'whisper', str(media), '--model', 'small.en', '--language', 'en', '--fp16', 'False', '--threads', '8', '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', str(out / 'asr')], out / 'whisper.log')
    audit.atomic(out / 'result.json', trimmed)
    return trimmed


def apply_publication_metadata(directory, speaker, title, description, output, source_speaker_evidence=None):
    directory = Path(directory)
    recipe, result = read(directory / 'recipe.json'), read(directory / 'result.json')
    allowed = [recipe['speaker']] + verify_source_speakers(source_speaker_evidence, recipe, result)
    speaker = validate_speaker(speaker, allowed)
    title, description = validate_publication_metadata(title, description)
    updated = {**recipe, 'speaker': speaker, 'title': title, 'reason': description, 'edit_notes': ''}
    if source_speaker_evidence is not None:
        updated['speaker_evidence'] = source_speaker_evidence
    if updated == recipe:
        return directory
    identity = audit.digest({'media_sha256': result['output_sha256'], 'recipe_hash': audit.digest(recipe), 'publication_metadata': {'speaker': speaker, 'title': title, 'description': description}, 'source_speaker_evidence': source_speaker_evidence})
    target = Path(output) / f"{result['candidate_id']}-metadata-{identity[:20]}"
    target.mkdir(parents=True, exist_ok=True)
    if (target / 'result.json').exists():
        cached = read(target / 'result.json')
        require(sha(target / 'clip.mp4') == cached['output_sha256'] and audit.digest(read(target / 'recipe.json')) == cached['recipe_hash'], 'Cached metadata-only rendition drift')
        return target
    for name in ('clip.mp4', 'qa.json', 'contact.jpg', 'trim.json'):
        if (directory / name).exists():
            shutil.copy2(directory / name, target / name)
    if (directory / 'asr').exists():
        shutil.copytree(directory / 'asr', target / 'asr', dirs_exist_ok=True)
    audit.atomic(target / 'parent-recipe.json', recipe)
    audit.atomic(target / 'recipe.json', updated)
    audit.atomic(target / 'result.json', {**result, 'recipe_hash': audit.digest(updated), 'clip_path': str((target / 'clip.mp4').resolve()), 'metadata_only': True, 'additional_gcs_bytes_read': 0, 'uploaded': False, 'database_written': False})
    return target


def apply_speaker_metadata(directory, speaker, output):
    # Compatibility for speaker-only callers; new finalizer uses all three fields.
    recipe = read(Path(directory) / 'recipe.json')
    return apply_publication_metadata(directory, speaker, recipe['title'], recipe['reason'], output)


def review_packages(packages, output, role='finalizer'):
    require(role in ('finalizer', 'verifier'), 'Unknown reviewer role')
    body = build_request(packages)
    if role == 'verifier':
        body['instructions'] = VERIFIER_PROMPT.read_text()
        body['text']['format']['schema'] = copy.deepcopy(SCHEMA)
        body['text']['format']['schema']['properties']['decisions']['items']['properties']['status']['enum'] = ['approve', 'review', 'reject']
    bind_request(body, packages)
    out = Path(output) / audit.digest(body)
    audit.atomic(out / 'packages.json', packages)
    audit.atomic(out / 'request.json', body)
    raw_path = out / 'response.json'
    api_called = not raw_path.exists()
    if api_called:
        state = out / 'call-state.json'
        require(not state.exists(), 'Prior API call has no durable response; inspect call-state before explicitly retrying (no automatic duplicate charges)')
        audit.atomic(state, {'role': role, 'status': 'started', 'time': audit.now()})
        import requests
        response = requests.post('https://api.openai.com/v1/responses', headers={'Authorization': 'Bearer ' + audit.api_key()}, json=body, timeout=(15, 300))
        response.raise_for_status()
        audit.atomic(raw_path, response.json())
        audit.atomic(state, {'role': role, 'status': 'response_saved', 'time': audit.now()})
    result = normalize(read(raw_path), packages, out, body)
    if role == 'verifier':
        require(all(d['status'] != 'adjust' for d in result['decisions']), 'Verifier is not allowed to edit')
    return {**result, 'role': role, 'api_called': api_called, 'artifact_directory': str(out.resolve())}


def contact_sheet(directory):
    directory = Path(directory)
    duration = read(directory / 'result.json')['duration_seconds']
    run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(directory / 'clip.mp4'), '-vf', f'fps=6/{duration},scale=320:-1,tile=3x2', '-frames:v', '1', str(directory / 'contact.jpg')], directory / 'contact.log')


def approval_receipt(decision, directory):
    directory = Path(directory)
    require(sha(directory / 'clip.mp4') == decision['media_sha256'], 'Approval media drift')
    require(audit.digest(read(directory / 'recipe.json')) == decision['recipe_hash'], 'Approval recipe drift')
    if decision['status'] != 'approve' or not decision['automatic_release_eligible']:
        return
    audit.atomic(directory / 'final-qa.json', {'passed': True, 'time': audit.now(), 'media_sha256': decision['media_sha256'], 'recipe_hash': decision['recipe_hash'], 'checks': {'picture_verified': True, 'dialogue_verified': True, 'boundaries_verified': True, 'duration_verified': True, 'metadata_verified': True}, 'reviewer': 'gpt-6-luna', 'evidence_hash': decision['evidence_hash'], 'evidence': {'picture': 'contact.jpg: sampled stills reviewed by Luna', 'dialogue': 'asr/clip.json: independent rendered-audio ASR reviewed by Luna', 'boundaries': decision['reason'], 'technical': 'qa.json'}, 'limitations': 'Model review of sampled frames and ASR; not human listening or frame-complete visual review'})


def current_package(directory, packets, image=None, feedback=None, verifier=False, review_round=None, experiment_id=None):
    p = package(directory, packets, image)
    trim_path = Path(directory) / 'trim.json'
    if trim_path.exists():
        p['evidence']['attempt'] = read(trim_path)['attempt']
        p['evidence']['trim_sha256'] = sha(trim_path)
    if review_round is not None:
        p['evidence']['review_round'] = review_round
        p['evidence']['experiment_id'] = experiment_id
    if feedback and not verifier:
        p['evidence']['verifier_feedback'] = feedback
    if verifier:
        # Published description is a claim to fact-check, not an approval rationale.
        p['evidence']['publication_metadata'] = {'title': p['evidence']['recipe']['title'], 'speaker': p['evidence']['recipe']['speaker'], 'description': p['evidence']['recipe']['reason'], 'publication_edit_notes': p['evidence']['recipe'].get('edit_notes', '')}
        # The verifier gets footage/ASR/context, never the finalizer's decision.
        p['evidence']['recipe'] = {k: v for k, v in p['evidence']['recipe'].items() if k not in ('decision', 'reason', 'edit_notes')}
    p['evidence'].pop('evidence_hash')
    p['evidence']['evidence_hash'] = audit.digest(p['evidence'])
    return p


def finalizer_package(original_directory, current_directory, packets, image=None, feedback=None, review_round=None, experiment_id=None):
    original_directory, current_directory = Path(original_directory), Path(current_directory)
    p = current_package(original_directory, packets, image, feedback, review_round=review_round, experiment_id=experiment_id)
    current = current_package(current_directory, packets, image if original_directory == current_directory else None)
    trim_path = current_directory / 'trim.json'
    if trim_path.exists():
        trim = read(trim_path)
        require(Path(trim['parent_clip_dir']).resolve() == original_directory.resolve(), 'Correction must plan from original media, not a recursively encoded child')
        start, end = trim['keep_start_seconds'], trim['keep_end_seconds']
    else:
        start, end = 0, p['evidence']['duration_seconds']
    p['evidence']['planning_timeline'] = 'All proposed keep endpoints refer to ORIGINAL local media/ASR above; approve keeps current_cut unchanged'
    p['evidence']['current_cut'] = {'original_start_seconds': start, 'original_end_seconds': end, 'media_sha256': current['evidence']['media_sha256'], 'recipe_hash': current['evidence']['recipe_hash'], 'asr_sha256': current['evidence']['asr_sha256'], 'asr_words_relative_to_current_clip': current['evidence']['asr_words'] if original_directory != current_directory else [], 'same_as_original': original_directory == current_directory, 'publication_metadata': {'title': current['evidence']['recipe']['title'], 'speaker': current['evidence']['recipe']['speaker'], 'description': current['evidence']['recipe']['reason'], 'publication_edit_notes': current['evidence']['recipe'].get('edit_notes', '')}}
    p['evidence'].pop('evidence_hash')
    p['evidence']['evidence_hash'] = audit.digest(p['evidence'])
    p['current_render_package'] = current
    return p


def escalation(output, vid, history, p):
    root = Path(output) / 'astra-escalations'
    data = {'schema_version': 'snippy-astra-escalation-v1', 'candidate_id': vid, 'complete': False, 'reason': 'No independent verifier PASS within five rounds', 'history': history, 'current_evidence': p, 'next_reviewer': 'astra'}
    audit.atomic(root / f'{vid}.json', data)
    path = root / f'{vid}.md'
    path.write_text('# Astra escalation: ' + vid + '\n\nFive Luna finalizer/verifier rounds exhausted. This clip is NOT complete or authorized for publication. Independently inspect the linked media, ASR, captions, and the full failure history. Resolve missing context or specify an exact executable repair; do not inherit prior approval claims.\n\n```json\n' + json.dumps(data, ensure_ascii=False, indent=2) + '\n```\n')
    return str(path.resolve())


def ensure_asr(directory, whisper_cli):
    directory = Path(directory)
    path, binding = directory / 'asr/clip.json', directory / 'asr/evidence.json'
    media_hash = sha(directory / 'clip.mp4')
    existing = read(binding) if binding.exists() else None
    require(existing is None or (existing['media_sha256'] == media_hash and path.exists() and existing['asr_sha256'] == sha(path)), 'Stale ASR binding; remove the stale ASR explicitly before regenerating')
    imported = path.exists() and existing is None
    if not path.exists():
        path.parent.mkdir(exist_ok=True)
        run([whisper_cli, str(directory / 'clip.mp4'), '--model', 'small.en', '--language', 'en', '--output_dir', str(path.parent), '--output_format', 'json', '--fp16', 'False', '--threads', '8', '--word_timestamps', 'True'], directory / 'whisper.log')
    require(words_from(read(path)), 'ASR returned no word timings')
    if existing is None:
        audit.atomic(binding, {'media_sha256': media_hash, 'asr_sha256': sha(path), 'created_at': audit.now(), 'provenance': 'Previously generated ASR supplied alongside this rendered clip; first binding established now' if imported else 'Local Whisper run on this exact media hash'})


def pipeline(args):
    started = time.monotonic()
    images = dict(item.split('=', 1) for item in args.images)
    originals, directories, outcomes, history, feedback = {}, {}, {}, {}, {}
    for directory in args.clips:
        directory = Path(directory).resolve()
        require(not (directory / 'trim.json').exists(), 'Pipeline starts with originals to preserve five-pass ancestry')
        vid = read(directory / 'result.json')['candidate_id']
        ensure_asr(directory, args.whisper_cli)
        require(vid not in originals, 'Duplicate candidates')
        if not images.get(vid) and not (directory / 'contact.jpg').exists():
            contact_sheet(directory)
        originals[vid] = current_package(directory, args.packets, images.get(vid))
        directories[vid], history[vid] = directory, []
    require(1 <= len(originals) <= 8, 'Pipeline batch must contain 1–8 clips')
    # A dedicated run directory prevents unrelated batches overwriting resume state.
    run_hash = audit.digest({'inputs': {vid: p['evidence']['evidence_hash'] for vid, p in originals.items()}, 'finalizer_prompt': sha(PROMPT), 'verifier_prompt': sha(VERIFIER_PROMPT), 'max_passes': MAX_PASSES, 'experiment_id': args.run_id})
    run_dir = args.output / 'pipelines' / run_hash
    saved_result = run_dir / 'pipeline-results.json'
    if saved_result.exists():
        result = read(saved_result)
        for decision in result['decisions']:
            require(sha(decision['media_path']) == decision['media_sha256'], 'Completed pipeline media drift')
            require(audit.digest(read(decision['recipe_path'])) == decision['recipe_hash'], 'Completed pipeline recipe drift')
        result.update(cache_hit=True, new_cost_usd=0, api_calls_this_invocation=0)
        audit.atomic(args.output / 'pipeline-results.json', result)
        return result
    ledger = {'schema_version': 'snippy-luna-loop-ledger-v1', 'run_hash': run_hash, 'max_passes': MAX_PASSES, 'rounds': []}
    calls = {}
    active = list(originals)
    for pass_number in range(1, MAX_PASSES + 1):
        row = {'pass': pass_number, 'active_candidates': list(active)}
        ledger['rounds'].append(row)
        audit.atomic(run_dir / 'ledger.json', ledger)
        finalizer_packages = [finalizer_package(originals[vid]['clip_dir'], directories[vid], args.packets, images.get(vid), feedback.get(vid), review_round=pass_number, experiment_id=args.run_id) for vid in active]
        finalized = review_packages(finalizer_packages, args.output, 'finalizer')
        calls[finalized['response_id']] = finalized
        row['finalizer'] = finalized
        audit.atomic(run_dir / 'ledger.json', ledger)
        round_errors = {}
        for decision in finalized['decisions']:
            vid = decision['candidate_id']
            if decision.get('action_validation_error'):
                round_errors[vid] = decision['action_validation_error']
                continue
            if decision['status'] == 'approve':
                try:
                    directories[vid] = apply_publication_metadata(directories[vid], decision['retained_speaker'], decision['final_title'], decision['final_description'], args.output / 'trimmed', next(p['evidence']['source_speaker_evidence'] for p in finalizer_packages if p['evidence']['candidate_id'] == vid))
                except Exception as exc:
                    round_errors[vid] = str(exc)
                continue
            if decision['status'] != 'adjust':
                continue
            try:
                trimmed = execute_trim(decision['trim_path'], args.output / 'trimmed')
                directory = Path(trimmed['clip_path']).parent
                ensure_asr(directory, args.whisper_cli)
                if not (directory / 'contact.jpg').exists():
                    contact_sheet(directory)
                directories[vid] = directory
            except Exception as exc:
                round_errors[vid] = str(exc)
        # Independent call gets current media evidence only; no finalizer output.
        verification_packages = [current_package(directories[vid], args.packets, images.get(vid) if directories[vid] == Path(originals[vid]['clip_dir']) else None, verifier=True, review_round=pass_number, experiment_id=args.run_id) for vid in active]
        row['verifier_pending'] = True
        audit.atomic(run_dir / 'ledger.json', ledger)
        verified = review_packages(verification_packages, args.output, 'verifier')
        calls[verified['response_id']] = verified
        row.update(verifier=verified, render_errors=round_errors)
        next_active = []
        for decision in verified['decisions']:
            vid = decision['candidate_id']
            finalizer_decision = next(d for d in finalized['decisions'] if d['candidate_id'] == vid)
            history[vid].append({'pass': pass_number, 'finalizer': finalizer_decision, 'verifier': decision, 'render_error': round_errors.get(vid), 'finalizer_response_id': finalized['response_id'], 'verifier_response_id': verified['response_id']})
            passed = decision['status'] == 'approve' and decision['automatic_release_eligible'] and vid not in round_errors
            directory = directories[vid]
            if passed:
                approval_receipt(decision, directory)
                outcomes[vid] = {**decision, 'status': 'pass', 'complete': True, 'attempts': pass_number, 'render_directory': str(directory), 'media_path': str(directory / 'clip.mp4'), 'recipe_path': str(directory / 'recipe.json'), 'history': history[vid]}
            else:
                next_active.append(vid)
                feedback[vid] = {'verifier_failure': decision, 'render_error': round_errors.get(vid)}
        row['passed_candidates'] = [vid for vid in active if vid not in next_active]
        audit.atomic(run_dir / 'ledger.json', ledger)
        active = next_active
        if not active:
            break
    for vid in active:
        p = current_package(directories[vid], args.packets)
        evidence = p['evidence']
        escalation_path = escalation(run_dir, vid, history[vid], p)
        outcomes[vid] = {'candidate_id': vid, 'status': 'escalated', 'complete': False, 'attempts': MAX_PASSES, 'media_sha256': evidence['media_sha256'], 'recipe_hash': evidence['recipe_hash'], 'media_path': str(directories[vid] / 'clip.mp4'), 'recipe_path': str(directories[vid] / 'recipe.json'), 'render_directory': str(directories[vid]), 'history': history[vid], 'astra_escalation_path': escalation_path, 'automatic_release_eligible': False}
    result = {'schema_version': 'snippy-luna-pipeline-v1', 'run_hash': run_hash, 'created_at': audit.now(), 'decisions': list(outcomes.values()), 'max_passes': MAX_PASSES, 'all_complete': not active, 'batch_response_ids': list(calls), 'cost_usd': sum(r['cost_usd'] for r in calls.values()), 'ledger_path': str((run_dir / 'ledger.json').resolve()), 'elapsed_seconds': time.monotonic() - started, 'cache_hit': False, 'new_cost_usd': sum(r['cost_usd'] for r in calls.values() if r.get('api_called')), 'api_calls_this_invocation': sum(bool(r.get('api_called')) for r in calls.values()), 'published': False}
    audit.atomic(saved_result, result)
    audit.atomic(args.output / 'pipeline-results.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'review', 'normalize', 'trim', 'pipeline'])
    parser.add_argument('--clips', nargs='+', type=Path)
    parser.add_argument('--render-dir', action='append', type=Path, default=[])
    parser.add_argument('--audit-run', type=Path, help='Accepted for shared runner compatibility; packets supply caption context')
    parser.add_argument('--run-id', default='default', help='Explicit experiment ID; change it for a fresh paid experiment, keep it to resume')
    parser.add_argument('--whisper-cli', default='/opt/homebrew/bin/whisper')
    parser.add_argument('--packets', type=Path, default=Path('.context/astra-clips/candidates'))
    parser.add_argument('--images', nargs='*', default=[], help='candidate_id=/path/contact.jpg')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--response', type=Path)
    parser.add_argument('--trim-plan', type=Path)
    parser.add_argument('--whisper-python')
    args = parser.parse_args()
    if args.command == 'trim':
        require(args.trim_plan is not None, '--trim-plan required')
        print(json.dumps(execute_trim(args.trim_plan, args.output, args.whisper_python), indent=2))
        return
    args.clips = (args.clips or []) + args.render_dir
    require(args.clips, '--clips or --render-dir required')
    if args.command == 'pipeline':
        print(json.dumps(pipeline(args), indent=2))
        return
    images = dict(item.split('=', 1) for item in args.images)
    packages = []
    for directory in args.clips:
        vid = read(directory / 'result.json')['candidate_id']
        p = package(directory, args.packets, images.get(vid))
        if (directory / 'trim.json').exists():
            trim = read(directory / 'trim.json')
            p['evidence'].update(attempt=1, parent_trim=trim)
            # recipe_hash remains bound to original recipe.json; trim separately hashed.
            p['evidence'].pop('evidence_hash')
            p['evidence']['evidence_hash'] = audit.digest(p['evidence'])
        packages.append(p)
    body = build_request(packages)
    h = audit.digest(body)
    out = args.output / h
    audit.atomic(out / 'packages.json', packages)
    audit.atomic(out / 'request.json', body)
    if args.command == 'prepare':
        print(json.dumps({'request_hash': h, 'directory': str(out.resolve()), 'clips': len(packages), 'api_called': False}))
        return
    raw_path = args.response or out / 'response.json'
    if not raw_path.exists():
        require(args.command == 'review', '--response does not exist')
        import requests
        response = requests.post('https://api.openai.com/v1/responses', headers={'Authorization': 'Bearer ' + audit.api_key()}, json=body, timeout=(15, 300))
        response.raise_for_status()
        audit.atomic(raw_path, response.json())
    print(json.dumps(normalize(read(raw_path), packages, out, body), indent=2))


if __name__ == '__main__':
    main()
