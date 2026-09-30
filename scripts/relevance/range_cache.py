"""On-demand original GCS byte pages, bound to immutable object identity and SHA."""
import hashlib
import io
import json
from pathlib import Path
import re
import threading
import uuid


def digest(data):
    return hashlib.sha256(data).hexdigest()


class CachedRaw(io.BytesIO):
    def read(self, amount=-1, decode_content=False):
        return super().read(amount)


class CachedResponse:
    def __init__(self, body, obj, start, end):
        self.status_code = 206
        self.headers = {'Content-Range': f"bytes {start}-{end}/{obj['size']}",
            'Content-Length': str(len(body)), 'Content-Encoding': 'identity',
            'x-goog-generation': str(obj['generation']), 'Content-Type': 'video/mp4'}
        self.raw = CachedRaw(body)

    def close(self):
        self.raw.close()


class OriginalRangeCache:
    _locks = {}
    _locks_guard = threading.Lock()

    def __init__(self, root, obj):
        self.identity = {key: str(obj[key]) for key in ('bucket', 'name', 'generation', 'size')}
        self.key = digest(json.dumps(self.identity, sort_keys=True).encode())
        self.root = Path(root).resolve() / self.key
        self.root.mkdir(parents=True, exist_ok=True)
        with self._locks_guard:
            self.lock = self._locks.setdefault(str(self.root), threading.RLock())
        self.exact_range_hits = self.covered_range_hits = 0

    def paths(self, start, end):
        if not (type(start) is int and type(end) is int and 0 <= start <= end < int(self.identity['size'])
                and end - start + 1 <= 1024 * 1024):
            raise ValueError('Original range cache only accepts bounded pages up to 1 MiB')
        return self.root / f'{start}-{end}.bin', self.root / f'{start}-{end}.json'

    def load(self, start, end, track_hit=True):
        with self.lock:
            return self._load(start, end, track_hit)

    def _load(self, start, end, track_hit):
        body_path, receipt_path = self.paths(start, end)
        segments = []
        for path in self.root.glob('*.json'):
            match = re.fullmatch(r'(\d+)-(\d+)\.json', path.name)
            if not match:
                continue
            lo, hi = map(int, match.groups())
            if hi < start or lo > end:
                continue
            binary, _ = self.paths(lo, hi)
            receipt = json.loads(path.read_text(encoding='utf-8'))
            body = binary.read_bytes()
            if (receipt.get('object') != self.identity or receipt.get('start') != lo or receipt.get('end') != hi
                    or len(body) != hi - lo + 1 or receipt.get('bytes') != len(body)
                    or receipt.get('sha256') != digest(body)):
                raise ValueError('Original byte-range cache identity, size or SHA drift')
            clipped_start, clipped_end = max(start, lo), min(end, hi)
            segments.append((clipped_start, body[clipped_start-lo:clipped_end-lo+1]))
        runs = []
        for lo, body in sorted(segments, key=lambda item: item[0]):
            if not runs or lo > runs[-1][0] + len(runs[-1][1]):
                runs.append((lo, bytearray(body)))
                continue
            run_start, joined = runs[-1]
            offset = lo - run_start
            overlap = min(len(body), len(joined) - offset)
            if joined[offset:offset+overlap] != body[:overlap]:
                raise ValueError('Same source generation has conflicting overlapping cached bytes')
            joined.extend(body[overlap:])
        if len(runs) != 1 or runs[0][0] != start or len(runs[0][1]) != end-start+1:
            return None
        if track_hit:
            if receipt_path.exists():
                self.exact_range_hits += 1
            else:
                self.covered_range_hits += 1
        return bytes(runs[0][1])

    def save(self, start, end, body):
        with self.lock:
            return self._save(start, end, body)

    def _save(self, start, end, body):
        body_path, receipt_path = self.paths(start, end)
        if len(body) != end - start + 1:
            raise ValueError('Cannot cache an incomplete original byte range')
        existing = self.load(start, end, track_hit=False)
        if existing is not None:
            if existing != body:
                raise ValueError('Same source generation/range returned different bytes')
            return
        for path in self.root.glob('*.json'):
            match = re.fullmatch(r'(\d+)-(\d+)\.json', path.name)
            if not match:
                continue
            lo, hi = map(int, match.groups())
            lo, hi = max(start, lo), min(end, hi)
            if lo <= hi:
                overlap = self.load(lo, hi, track_hit=False)
                if overlap != body[lo-start:hi-start+1]:
                    raise ValueError('Same source generation/range returned different overlapping bytes')
        nonce = uuid.uuid4().hex
        temporary = body_path.with_suffix('.' + nonce + '.tmp')
        temporary.write_bytes(body)
        temporary.replace(body_path)
        receipt = {'schema_version': 'snippy-original-range-cache-v1', 'object': self.identity,
            'start': start, 'end': end, 'bytes': len(body), 'sha256': digest(body),
            'source': 'Validated generation-pinned HTTP 206 original bytes; no transcoding'}
        temporary = receipt_path.with_suffix('.' + nonce + '.tmp')
        temporary.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
        temporary.replace(receipt_path)
