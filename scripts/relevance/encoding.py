"""Explicit, hash-bound encoder selection. Never changes drivers or falls back."""
from fractions import Fraction
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import audit

PROFILES = {
    'x264_slow': ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18'],
    'x264_fast': ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18'],
    'x264_veryfast': ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'],
    'nvenc_p4': ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0'],
    'nvenc_p6': ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0'],
}


def selected(environment=None):
    environment = os.environ if environment is None else environment
    profile = environment.get('SNIPPY_ENCODER_PROFILE', 'x264_slow')
    if profile not in PROFILES:
        raise ValueError('Unknown SNIPPY_ENCODER_PROFILE; no encoder fallback')
    requested = environment.get('SNIPPY_FFMPEG', 'ffmpeg')
    resolved = shutil.which(requested)
    path = Path(resolved or requested)
    # Scoop shims are launchers; bind the actual codec binary rather than the shim.
    shim = path.with_suffix('.shim')
    if shim.is_file():
        match = re.search(r'^path\s*=\s*"([^"]+)"', shim.read_text(encoding='utf-8'), re.MULTILINE)
        if match:
            path = Path(match.group(1))
    path = path.resolve()
    if not path.is_file():
        raise ValueError('SNIPPY_FFMPEG binary is missing; no fallback')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    version = subprocess.run([str(path), '-version'], capture_output=True, text=True, timeout=30, check=True).stdout.splitlines()[0]
    config = {'schema_version': 'snippy-encoding-v1', 'profile': profile, 'binary_path': str(path),
              'binary_sha256': h.hexdigest(), 'ffmpeg_version': version,
              'video_args': PROFILES[profile], 'audio_args': ['-c:a', 'aac', '-b:a', '192k'],
              'fps_args': ['-fps_mode', 'passthrough']}
    config['identity'] = audit.digest(config)
    return config


def output_args(config):
    return config['video_args'] + config['fps_args'] + config['audio_args'] + ['-movflags', '+faststart']


def native_fps(output_video, source_video):
    try:
        output, source = Fraction(output_video['r_frame_rate']), Fraction(source_video['r_frame_rate'])
        return source > 0 and output == source
    except (KeyError, ValueError, ZeroDivisionError):
        return False
