#!/usr/bin/env python3
"""Local CUDA small.en adapter for the OpenAI Whisper CLI flags used by Luna.

Run using the Python environment containing faster-whisper and NVIDIA runtime
wheels. The small.en model must already be cached; no CPU/model/API fallback is
allowed. JSON is published only after transcription and word validation succeed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile


MODEL = 'small.en'
MODEL_REPOSITORY = 'Systran/faster-whisper-small.en'
_DLL_HANDLES = []


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def prepare_dll_dirs():
    """Retain add_dll_directory handles for the lifetime of the loaded model."""
    try:
        import nvidia
    except ImportError:
        return []  # A system CUDA installation may supply the runtime instead.
    added = []
    for root in nvidia.__path__:
        for package in ('cublas', 'cudnn', 'cuda_runtime', 'cuda_nvrtc'):
            for leaf in ('bin', 'lib'):
                directory = Path(root) / package / leaf
                if directory.is_dir():
                    if os.name == 'nt':
                        _DLL_HANDLES.append(os.add_dll_directory(str(directory)))
                    os.environ['PATH'] = str(directory) + os.pathsep + os.environ.get('PATH', '')
                    added.append(str(directory))
    return added


def load_model(fp16=False, threads=8, download_root=None):
    prepare_dll_dirs()
    import ctranslate2
    import faster_whisper
    from faster_whisper.utils import download_model

    if ctranslate2.get_cuda_device_count() < 1:
        raise RuntimeError('CUDA is required; CTranslate2 sees no CUDA device')
    compute_type = 'float16' if fp16 else 'float32'
    if compute_type not in ctranslate2.get_supported_compute_types('cuda'):
        raise RuntimeError(f'CUDA does not support requested {compute_type}; no fallback permitted')
    model_path = download_model(MODEL, local_files_only=True, cache_dir=download_root)
    model = faster_whisper.WhisperModel(
        model_path, device='cuda', device_index=0, compute_type=compute_type,
        cpu_threads=threads, local_files_only=True,
    )
    actual_device = model.model.device
    actual_compute = model.model.compute_type
    if actual_device != 'cuda' or actual_compute != compute_type:
        raise RuntimeError(f'Unexpected runtime: {actual_device}/{actual_compute}; no fallback permitted')
    return model, {
        'engine': 'faster-whisper', 'engine_version': faster_whisper.__version__,
        'ctranslate2_version': ctranslate2.__version__, 'model': MODEL,
        'model_repository': MODEL_REPOSITORY, 'model_cache_path': str(model_path),
        'device': actual_device, 'device_index': 0, 'compute_type': actual_compute,
        'requested_fp16': fp16, 'threads': threads, 'local_files_only': True,
        'diarization': False, 'timestamps': 'word (cross-attention alignment; approximate)',
    }


def transcribe_media(source, model, provider):
    source = Path(source).resolve()
    input_hash = sha256(source)
    segments, info = model.transcribe(
        str(source), language='en', beam_size=5, word_timestamps=True,
        vad_filter=False, condition_on_previous_text=False,
    )
    rows, all_words, previous = [], [], -1.0
    for segment in segments:  # Consume the lazy generator before publishing output.
        words = []
        for word in segment.words or []:
            text = word.word.strip()
            if not text:
                continue
            start, end = float(word.start), float(word.end)
            if not (math.isfinite(start) and math.isfinite(end) and 0 <= start <= end and start >= previous):
                raise ValueError('ASR returned invalid or unordered word timestamps')
            previous = start
            value = {'word': text, 'text': text, 'start': start, 'end': end}
            words.append(value)
            all_words.append(value)
        rows.append({'start': float(segment.start), 'end': float(segment.end),
                     'text': segment.text.strip(), 'words': words})
    if not all_words:
        raise ValueError('ASR returned no word timings')
    if sha256(source) != input_hash:
        raise ValueError('Input media changed during transcription')
    return {
        'text': ' '.join(word['text'] for word in all_words), 'language': 'en',
        'audio_duration_secs': float(info.duration), 'words': all_words, 'segments': rows,
        'provider': {**provider, 'input_path': str(source), 'input_sha256': input_hash,
                     'beam_size': 5, 'vad_filter': False, 'condition_on_previous_text': False,
                     'transcribed_at': datetime.now(timezone.utc).isoformat()},
    }


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                         prefix=path.name + '.', suffix='.tmp', delete=False) as stream:
            temp = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    finally:
        if temp is not None and temp.exists():
            temp.unlink()


def boolean(value):
    if value.lower() not in ('true', 'false'):
        raise argparse.ArgumentTypeError('expected True or False')
    return value.lower() == 'true'


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('media', type=Path)
    result.add_argument('--model', choices=[MODEL], default=MODEL)
    result.add_argument('--language', choices=['en'], default='en')
    result.add_argument('--device', choices=['cuda'], default='cuda')
    result.add_argument('--output_dir', type=Path, required=True)
    result.add_argument('--output_format', choices=['json'], default='json')
    result.add_argument('--fp16', type=boolean, default=False)
    result.add_argument('--threads', type=int, default=8)
    result.add_argument('--word_timestamps', type=boolean, choices=[True], default=True)
    result.add_argument('--download-root', default=None)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    if args.threads < 1:
        raise ValueError('--threads must be positive')
    if not args.media.is_file():
        raise FileNotFoundError(args.media)
    model, provider = load_model(args.fp16, args.threads, args.download_root)
    record = transcribe_media(args.media, model, provider)
    output = args.output_dir / (args.media.stem + '.json')
    write_json(output, record)
    print(json.dumps({'output': str(output), 'words': len(record['words']),
                      'model': provider['model'], 'device': provider['device'],
                      'compute_type': provider['compute_type']}), flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        raise SystemExit(1)
