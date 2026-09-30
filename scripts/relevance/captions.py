"""Parse immutable snapshot captions, including multiline segment text.

A timestamp starts a record; physical newlines inside its text do not start
new records. Only line separators are replaced with spaces, preserving words,
punctuation, speaker markers, and transcription errors.
"""
import math
import re


_START = re.compile(r'^\[(\d+(?:\.\d+)?)\](?:[ \t](.*))?$')
_BAD_TIMESTAMP = re.compile(r'^\[(?:[\d.+-]+|unknown|nan|inf)\](?:\s|$)')


def parse_captions(transcript):
    captions = []
    for number, line in enumerate(transcript.splitlines(), 1):
        match = _START.fullmatch(line)
        if match:
            timestamp = float(match[1])
            if not math.isfinite(timestamp) or (captions and timestamp < captions[-1][0]):
                raise ValueError(f'Invalid or decreasing caption timestamp at line {number}')
            captions.append((timestamp, match[2] or ''))
        elif not line.strip():
            continue
        elif not captions or _BAD_TIMESTAMP.match(line):
            raise ValueError(f'Unparseable source caption at line {number}')
        else:
            timestamp, text = captions[-1]
            captions[-1] = (timestamp, text + (' ' if text else '') + line)
    return captions


def caption_context(transcript, start, end):
    """Return whole records whose start lies within an inclusive context window."""
    return '\n'.join(
        f'[{str(timestamp).removesuffix(".0")}] {text}'
        for timestamp, text in parse_captions(transcript)
        if start <= timestamp <= end
    )
