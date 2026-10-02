"""Receipted actual-audio evidence; never an editorial/publication approval."""
import argparse
import base64
import datetime
import hashlib
import json
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

import audit

MODEL = 'gpt-audio-1.5'
FIELDS = ('transcription', 'exact_opening_words', 'exact_closing_words',
          'audibility_and_defects', 'cut_syllables_or_incomplete_sentence', 'uncertainty')
PROMPT = ('Analyze this actual audio as technical evidence only. Do not identify people or '
          'make editorial/publication decisions. Transcribe ALL audible words in their original '
          'language, preserving hesitations, hedges, numbers and negations. Report exact opening '
          'and closing words, cut syllables or incomplete sentences, intelligibility of EVERY '
          'speaking voice, and concrete audible defects with approximate seconds. Explicitly '
          'flag uncertainty. Do not infer inaudible words from context. Return JSON only, with '
          'string fields: ' + ', '.join(FIELDS) + '. This is automated analysis, not human listening.')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def write(path, obj):
    audit.atomic(path, obj)


def extract(media, target):
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a',
        '-show_entries', 'stream=index', '-of', 'json', str(media)],
        check=True, capture_output=True, timeout=30)
    if len(json.loads(probe.stdout).get('streams', [])) != 1:
        raise ValueError('Exactly one audio stream is required; explicitly mix speaker tracks first')
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(media), '-map', '0:a:0', '-vn',
                    '-c:a', 'pcm_s16le', '-n', str(target)], check=True,
                   capture_output=True, timeout=300)


class ResponseReadError(RuntimeError):
    def __init__(self, response, cause):
        super().__init__(str(cause))
        self.receipt = {'http_status': response.status,
            'request_id': response.headers.get('x-request-id'),
            'response_body_base64': base64.b64encode(getattr(cause, 'partial', b'')).decode(),
            'body_read_error': str(cause), 'charge_reconciled': False}


def read_response(response):
    try:
        return response.read()
    except Exception as exc:
        raise ResponseReadError(response, exc) from exc


def send(body):
    request = urllib.request.Request('https://api.openai.com/v1/chat/completions',
        data=body, headers={'Authorization': 'Bearer ' + audit.api_key(),
                            'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=180) as response:
        return read_response(response), response.headers.get('x-request-id')


def parse(response):
    choice = response['choices'][0]
    if choice.get('finish_reason') != 'stop' or choice['message'].get('refusal'):
        raise ValueError('Incomplete or refused audio analysis')
    text = choice['message']['content'].strip()
    if text.startswith('```') and text.endswith('```'):
        text = '\n'.join(text.splitlines()[1:-1])
    result = json.loads(text)
    if not isinstance(result, dict) or any(not isinstance(result.get(k), str) for k in FIELDS):
        raise ValueError('Missing technical audio evidence fields')
    return result


def run(media, out, sender=send, extractor=extract):
    media, out = Path(media).resolve(), Path(out).resolve()
    digest = sha(media)
    # A directory is an immutable attempt, including failures and uncertain charges.
    # mkdir is also an exclusive reservation against concurrent duplicate requests.
    out.mkdir(parents=True, exist_ok=False)
    audio = out / 'audio.wav'
    try:
        extractor(media, audio)
        if sha(media) != digest:
            raise ValueError('Media changed during audio extraction')
    except Exception as exc:
        write(out / 'failure.json', {'status': 'preparation_failed', 'error': str(exc),
            'media_sha256': digest, 'request_sent': False, 'completed_at': now(),
            'approved_for_publication': False})
        raise
    body = json.dumps({'model': MODEL, 'modalities': ['text'], 'store': False,
        'temperature': 0, 'max_completion_tokens': 6000,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': PROMPT},
            {'type': 'input_audio', 'input_audio': {
                'data': base64.b64encode(audio.read_bytes()).decode(), 'format': 'wav'}}]}]}).encode()
    receipt = {'started_at': now(), 'model': MODEL, 'media_path': str(media),
        'media_sha256': digest, 'audio_sha256': sha(audio),
        'request_sha256': hashlib.sha256(body).hexdigest(), 'prompt': PROMPT,
        'attempt': 1, 'automatic_retry': False, 'approved_for_publication': False,
        'purpose': 'Technical actual-audio evidence; root owns editorial decisions',
        'status': 'in_flight'}
    write(out / 'request-receipt.json', receipt)
    try:
        raw_response, request_id = sender(body)
        receipt.update(status='response_received', http_status=200,
                       response_body_base64=base64.b64encode(raw_response).decode(),
                       request_id=request_id, completed_at=now())
        # Preserve provider response before parsing so a malformed response cannot replay.
        write(out / 'response.json', receipt)
        response = json.loads(raw_response)
        receipt['response'] = response
        evidence = parse(response)
        if sha(media) != digest:
            raise ValueError('Media changed during audio analysis')
        receipt.update(status='evidence_ready', evidence=evidence)
        write(out / 'evidence.json', receipt)
        return receipt
    except ResponseReadError as exc:
        receipt.update(exc.receipt, status='response_read_failed', completed_at=now())
        write(out / 'failure.json', receipt)
        raise
    except urllib.error.HTTPError as exc:
        receipt.update(status='http_error', http_status=exc.code, completed_at=now(),
                       request_id=exc.headers.get('x-request-id'), charge_reconciled=False)
        try:
            raw_error = read_response(exc)
            receipt.update(error_body=raw_error.decode(errors='replace'),
                           response_body_base64=base64.b64encode(raw_error).decode())
        except ResponseReadError as read_error:
            receipt.update(read_error.receipt)
        finally:
            exc.close()
        write(out / 'failure.json', receipt)
        raise
    except Exception as exc:
        receipt.update(status='evidence_failed' if 'response_body_base64' in receipt else 'charge_unknown',
                       error=str(exc), completed_at=now())
        write(out / 'failure.json', receipt)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--media', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True, help='New immutable attempt directory')
    args = parser.parse_args()
    result = run(args.media, args.out)
    print(json.dumps({'status': result['status'], 'model': MODEL,
                      'usage': result['response'].get('usage'),
                      'request_id': result['request_id'], 'evidence': str(args.out / 'evidence.json')}))


if __name__ == '__main__':
    main()
