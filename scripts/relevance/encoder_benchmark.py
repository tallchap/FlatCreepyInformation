#!/usr/bin/env python3
"""Sequential, local-only encoder comparison on a hash-bound cached window."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from fractions import Fraction
import audit
from bounded_window_cache import open_window
from process_astra import require, sha

PROFILES = {
    'x264_slow': ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18'],
    'x264_fast': ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18'],
    'x264_veryfast': ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'],
    'nvenc_p4': ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0'],
    'nvenc_p6': ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0'],
}


def run(command, log, binary=False):
    start = time.monotonic()
    proc = subprocess.run(command, capture_output=True, timeout=1800)
    Path(log).write_bytes(proc.stderr)
    return {'command': command, 'exit_code': proc.returncode, 'wall_seconds': time.monotonic() - start}, proc.stdout if binary else proc.stdout.decode('utf-8', errors='replace')


def probe(media, log):
    receipt, value = run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(media)], log)
    require(receipt['exit_code'] == 0, 'Probe failed: ' + str(log))
    return json.loads(value)


def benchmark(directory, input_root, output, start, duration, profiles=None, encoder_binary='ffmpeg'):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache = open_window(directory, input_root)
    require(0 <= start and 0 < duration <= 240 and start + duration <= cache['duration_seconds'], 'Benchmark trim outside cached window')
    media = cache['media_path']
    profile_names = profiles or list(PROFILES)
    require(all(name in PROFILES for name in profile_names), 'Unknown encoding profile')
    binary_receipt, binary_version = run([str(encoder_binary), '-version'], output / 'encoder-version.log')
    require(binary_receipt['exit_code'] == 0, 'Encoder binary is unavailable')
    plan = {'cache': {k: v for k, v in cache.items() if k != 'validation_elapsed_seconds'},
            'encoder_binary': str(encoder_binary), 'encoder_version': binary_version.splitlines()[0],
            'encoder_binary_sha256': sha(encoder_binary) if Path(encoder_binary).is_file() else None,
            'start_seconds': start, 'duration_seconds': duration, 'profiles': {name: PROFILES[name] for name in profile_names}}
    plan_hash = audit.digest(plan)
    manifest = output / 'benchmark-plan.json'
    if manifest.exists():
        require(json.loads(manifest.read_text())['plan_hash'] == plan_hash, 'Benchmark plan changed; use a new output directory')
    else:
        audit.atomic(manifest, {'plan_hash': plan_hash, **plan})
    source_probe = probe(media, output / 'source-probe.log')
    sv = next(s for s in source_probe['streams'] if s['codec_type'] == 'video')
    source_input = ['-ss', str(start), '-i', media, '-t', str(duration)]
    reference, pcm = run(['ffmpeg', '-nostdin', '-v', 'error', *source_input, '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', '-f', 's16le', '-'], output / 'reference-audio.log', True)
    require(reference['exit_code'] == 0, 'Reference audio decode failed')
    report_path = output / 'encoder-benchmark.json'
    report = {'schema_version': 'snippy-encoder-benchmark-v1', 'created_at': audit.now(), 'plan_hash': plan_hash,
              'cache': cache, 'native_video': {k: sv.get(k) for k in ('width', 'height', 'avg_frame_rate', 'r_frame_rate', 'pix_fmt')},
              'start_seconds': start, 'duration_seconds': duration, 'reference_audio_pcm_sha256': hashlib.sha256(pcm).hexdigest(),
              'variants': [], 'additional_gcs_bytes_read': 0, 'paid_model_calls': 0,
              'limitations': ['All variants re-encode the same previously encoded bounded window, not raw original source bytes.',
                  'CRF18 and NVENC CQ18 are different quality controls; objective metrics and human review decide suitability.',
                  'Encode-only wall time excludes metrics, full decode, image/audio samples and cache validation.',
                  'No editorial, speaker, confidence or publication gates are changed.']}
    if report_path.exists():
        saved = json.loads(report_path.read_text())
        require(saved['plan_hash'] == plan_hash, 'Saved benchmark plan drift')
        report = saved
    completed = {v['profile']: v for v in report['variants']}
    for name in profile_names:
        if name in completed:
            require(sha(output / name / 'clip.mp4') == completed[name]['media_sha256'], 'Cached benchmark output drift')
            continue
        folder = output / name
        require(not folder.exists(), 'Partial benchmark exists; inspect it rather than silently rerun')
        folder.mkdir()
        video = folder / 'clip.mp4'
        command = [str(encoder_binary), '-nostdin', '-hide_banner', '-v', 'error', '-y', *source_input,
                   '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn', *PROFILES[name],
                   '-pix_fmt', sv['pix_fmt'], '-fps_mode', 'passthrough', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(video)]
        encoded, _ = run(command, folder / 'encode.log')
        require(encoded['exit_code'] == 0, 'Encoder failed: ' + str(folder / 'encode.log'))
        vp = probe(video, folder / 'probe.log'); v = next((s for s in vp['streams'] if s['codec_type'] == 'video'), {})
        a = next((s for s in vp['streams'] if s['codec_type'] == 'audio'), {})
        decoded, _ = run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-i', str(video), '-f', 'null', '-'], folder / 'decode.log')
        checks = {'video': bool(v), 'audio': bool(a), 'native_dimensions': (v.get('width'), v.get('height')) == (sv['width'], sv['height']),
                  'native_fps': Fraction(v['r_frame_rate']) == Fraction(sv['r_frame_rate']),
                  'duration': abs(float(vp['format']['duration']) - duration) < .3, 'full_decode': decoded['exit_code'] == 0}
        audio_receipt, audio_pcm = run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(video), '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', '-f', 's16le', '-'], folder / 'audio-decode.log', True)
        checks['audio_decode'] = audio_receipt['exit_code'] == 0
        variant = {'profile': name, 'encode': encoded, 'media_path': str(video), 'media_sha256': sha(video),
                   'output_bytes': video.stat().st_size, 'duration_seconds': float(vp['format']['duration']), 'checks': checks,
                   'audio_pcm_sha256': hashlib.sha256(audio_pcm).hexdigest(), 'audio_pcm_bytes': len(audio_pcm), 'metrics': {}, 'samples': []}
        for metric in ('ssim', 'psnr'):
            filt = f'[0:v]settb=AVTB,setpts=PTS-STARTPTS[ref];[1:v]settb=AVTB,setpts=PTS-STARTPTS[test];[test][ref]{metric}'
            receipt, _ = run(['ffmpeg', '-nostdin', '-hide_banner', '-ss', str(start), '-t', str(duration), '-i', media, '-i', str(video),
                              '-lavfi', filt, '-an', '-f', 'null', '-'], folder / (metric + '.log'))
            log = (folder / (metric + '.log')).read_text(errors='replace')
            match = re.findall(r'All:([0-9.]+)' if metric == 'ssim' else r'average:([0-9.inf]+)', log)
            variant['metrics'][metric] = {'exit_code': receipt['exit_code'], 'value': float(match[-1]) if match else None,
                                           'reference': 'decoded cached parent exact local trim', 'log': str(folder / (metric + '.log'))}
        for index, at in enumerate((.25, duration / 2, max(.25, duration - .5))):
            image = folder / f'frame-{index}.jpg'
            sample, _ = run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', str(at), '-i', str(video), '-frames:v', '1', '-q:v', '2', str(image)], folder / f'frame-{index}.log')
            variant['samples'].append({'time': at, 'path': str(image), 'exit_code': sample['exit_code']})
        audio = folder / 'listen.wav'
        listen, _ = run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(video), '-t', str(min(duration, 12)), '-vn', '-c:a', 'pcm_s16le', str(audio)], folder / 'listen.log')
        variant['listen'] = {'path': str(audio), 'exit_code': listen['exit_code']}
        variant['passed'] = all(checks.values()) and all(m['exit_code'] == 0 and m['value'] is not None for m in variant['metrics'].values())
        report['variants'].append(variant)
        report['identical_decoded_audio_across_variants'] = len({v['audio_pcm_sha256'] for v in report['variants']}) == 1
        report['updated_at'] = audit.now()
        audit.atomic(report_path, report)
        print(json.dumps({'profile': name, 'wall_seconds': encoded['wall_seconds'], 'bytes': variant['output_bytes'],
                          'ssim': variant['metrics']['ssim']['value'], 'psnr': variant['metrics']['psnr']['value'],
                          'passed': variant['passed'], 'audio_identical': report['identical_decoded_audio_across_variants']}), flush=True)
    second_cache = open_window(directory, input_root)
    require(second_cache['cache_key'] == cache['cache_key'] and second_cache['media_sha256'] == cache['media_sha256'], 'Parent cache drift after encodes')
    report['cache_revalidated_after_all_encoder_changes'] = second_cache
    report['finished_at'] = audit.now()
    audit.atomic(report_path, report)
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, required=True); p.add_argument('--input-root', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True); p.add_argument('--start', type=float, default=2)
    p.add_argument('--duration', type=float, default=20); p.add_argument('--profiles', nargs='+', choices=list(PROFILES))
    p.add_argument('--encoder-binary', default='ffmpeg')
    a = p.parse_args()
    r = benchmark(a.directory, a.input_root, a.output, a.start, a.duration, a.profiles, a.encoder_binary)
    return 0 if all(v['passed'] for v in r['variants']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
