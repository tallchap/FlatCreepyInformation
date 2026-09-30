#!/usr/bin/env python3
"""Offline preparation timing from existing logs and receipts, with no probes.

Never treats an ASR phase (which includes its queue) as measured GPU inference.
Never treats preparation-barrier throughput as steady streaming throughput.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import statistics

import audit
from benchmark_report import elapsed, timestamp
from production_report import numeric

STAGE_LINE = re.compile(r'^(\d{4}-\d\d-\d\dT\S+)\s+([A-Za-z0-9_-]{11})\s+(preparing|transcribing|prepared|failed|awaiting_astra)\s*$')
DEFINITIONS = {
    'preparing_to_transcribing_seconds': 'Stage-log elapsed: render-slot wait + validation/source metadata + range-read/encode + technical QA/hash + ledger overhead.',
    'active_render_pipeline_seconds': 'result.elapsed_seconds: measured from ffmpeg-version through ranged render, assembly, probe/full decode, and output SHA; excludes prior render-slot wait/source metadata.',
    'ranged_render_seconds': 'transfer.elapsed_seconds: source probe + range reads and concurrent encoding + proxy shutdown. Download and encoding are inseparable.',
    'post_range_technical_qa_and_hash_seconds': 'result.elapsed_seconds minus transfer.elapsed_seconds: assembly/rename + output probe/full decode + output hash and receipt overhead; not pure QA CPU time.',
    'pre_render_wait_metadata_and_ledger_residual_seconds': 'preparing -> transcribing minus active render elapsed: render-slot wait + validation/source metadata + ledger overhead; not isolated queue time.',
    'asr_queue_startup_decode_inference_and_hash_seconds': 'transcribing log -> provider.transcribed_at: ASR-slot wait + model/process startup + audio decode + GPU inference + media hashes + ledger overhead. Components have no separate start stamps.',
    'asr_exit_validation_and_binding_seconds': 'provider.transcribed_at -> asr/evidence.created_at: JSON persistence, process exit, word validation/media+ASR binding hashes.',
    'contact_sheet_and_ledger_seconds': 'asr/evidence.created_at -> prepared log: contact-sheet generation (if missing) plus ledger overhead; not editorial Luna QA.',
    'transcribing_to_prepared_seconds': 'Complete ASR queue/startup/decode/inference/binding + contact-sheet stage-log interval.',
    'preparing_to_prepared_seconds': 'Complete per-candidate preparation latency, including queues and all observed preparation stages.',
    'upstream_request_lifetime_union_seconds': 'Union of range HTTP handler started_at -> finished_at; includes downstream encoder backpressure and cancellations, overlaps encoding, not pure download time.',
}


def summary(values):
    values = sorted(v for v in values if numeric(v))
    if not values:
        return {'measured_count': 0, 'sum_seconds': 0, 'median_seconds': None, 'p90_seconds': None, 'max_seconds': None}
    return {'measured_count': len(values), 'sum_seconds': round(sum(values), 6),
        'median_seconds': round(statistics.median(values), 6),
        'p90_seconds': round(values[max(0, (len(values) * 9 + 9)//10 - 1)], 6),
        'max_seconds': round(max(values), 6)}


def union_seconds(requests):
    intervals = []
    for request in requests:
        a, b = timestamp(request.get('started_at')), timestamp(request.get('finished_at'))
        if a is not None and b is not None and b >= a:
            intervals.append((a, b))
    if not intervals:
        return None
    total, last = 0.0, None
    for a, b in sorted(intervals):
        total += max(0, b - max(a, last if last is not None else a))
        last = max(b, last if last is not None else b)
    return round(total, 6)


class PreparationTiming:
    def __init__(self, root, experiment_id, as_of=None):
        self.root, self.experiment_id = Path(root).resolve(), experiment_id
        self.as_of = as_of or audit.now()
        self.errors = []

    def read(self, path, optional=True):
        path = Path(path)
        if optional and not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError) as exc:
            self.errors.append({'path': str(path), 'error': type(exc).__name__})
            return None

    def experiment_files(self):
        candidates = [self.root, self.root / 'experiments' / self.experiment_id / 'artifacts',
                      self.root / 'experiments' / self.experiment_id,
                      self.root / 'experiment-history' / self.experiment_id]
        for base in candidates:
            plan = self.read(base / 'experiment-plan.json')
            if plan and plan.get('experiment_id') == self.experiment_id:
                return base, plan, self.read(base / 'experiment-status.json') or {}
        raise ValueError('Matching frozen experiment plan not found')

    def stages(self, ids, started_at, finished_at, archive_base=None):
        events, seen, paths = defaultdict(list), set(), []
        lower, upper = timestamp(started_at), timestamp(finished_at) or timestamp(self.as_of)
        # Only durable runner logs; no recursive media scan or subprocess probes.
        log_paths = set(self.root.glob('production-attempt-*.log'))
        if archive_base is not None:
            log_paths.update(archive_base.glob('production-attempt-*.log'))
        for path in sorted(log_paths):
            paths.append(str(path))
            with path.open(encoding='utf-8-sig', errors='replace') as stream:
                for line_number, line in enumerate(stream, 1):
                    match = STAGE_LINE.match(line.strip())
                    if not match:
                        continue
                    when, vid, stage = match.groups()
                    moment = timestamp(when)
                    if vid not in ids or moment is None or (lower is not None and moment < lower) or (upper is not None and moment > upper):
                        continue
                    key = (when, vid, stage)
                    if key not in seen:
                        seen.add(key)
                        events[vid].append({'time': when, 'stage': stage, 'log_path': str(path), 'line': line_number})
        for rows in events.values():
            rows.sort(key=lambda row: timestamp(row['time']))
        return events, paths

    def artifacts(self, vid):
        values = []
        for directory in sorted((self.root / 'rendered').glob(vid + '-*')):
            result = self.read(directory / 'result.json')
            transfer = self.read(directory / 'transfer.json')
            asr = self.read(directory / 'asr/clip.json')
            binding = self.read(directory / 'asr/evidence.json')
            values.append({'directory': str(directory), 'result': result or {}, 'transfer': transfer or {},
                           'provider': (asr or {}).get('provider', {}), 'binding': binding or {}})
        return values

    def candidate(self, vid, lane, events):
        artifacts = self.artifacts(vid)
        attempts = []
        for event in events:
            if event['stage'] == 'preparing' or not attempts:
                attempts.append({'events': []})
            attempts[-1]['events'].append(event)
        for attempt in attempts:
            stage_times = {}
            for event in attempt['events']:
                stage_times.setdefault(event['stage'], event['time'])
            preparing, transcribing, prepared = (stage_times.get(k) for k in ('preparing', 'transcribing', 'prepared'))
            # Current initial-render receipt is associated by its creation time;
            # a cached earlier receipt must not be charged as fresh active work.
            eligible = [a for a in artifacts if timestamp(a['result'].get('created_at')) is not None and
                        (timestamp(transcribing) is None or timestamp(a['result']['created_at']) <= timestamp(transcribing) + 1)]
            artifact = max(eligible, key=lambda a: timestamp(a['result']['created_at'])) if eligible else (artifacts[0] if len(artifacts) == 1 else {})
            result, transfer = artifact.get('result', {}), artifact.get('transfer', {})
            provider, binding = artifact.get('provider', {}), artifact.get('binding', {})
            created = timestamp(result.get('created_at'))
            cached = bool(created is not None and timestamp(preparing) is not None and created < timestamp(preparing))
            asr_finished, bound_at = provider.get('transcribed_at'), binding.get('created_at')
            asr_cached = bool(timestamp(asr_finished) is not None and timestamp(transcribing) is not None and timestamp(asr_finished) < timestamp(transcribing))
            active = result.get('elapsed_seconds') if not cached else None
            ranged = transfer.get('elapsed_seconds') if not cached else None
            front = elapsed(preparing, transcribing)
            metrics = {key: None for key in DEFINITIONS}
            metrics.update(preparing_to_transcribing_seconds=front,
                active_render_pipeline_seconds=active if numeric(active) else None,
                ranged_render_seconds=ranged if numeric(ranged) else None,
                transcribing_to_prepared_seconds=elapsed(transcribing, prepared),
                preparing_to_prepared_seconds=elapsed(preparing, prepared))
            if numeric(active) and numeric(ranged) and active >= ranged:
                metrics['post_range_technical_qa_and_hash_seconds'] = round(active-ranged, 6)
            if numeric(front) and numeric(active) and front >= active:
                metrics['pre_render_wait_metadata_and_ledger_residual_seconds'] = round(front-active, 6)
            if not asr_cached:
                metrics['asr_queue_startup_decode_inference_and_hash_seconds'] = elapsed(transcribing, asr_finished)
                metrics['asr_exit_validation_and_binding_seconds'] = elapsed(asr_finished, bound_at)
                metrics['contact_sheet_and_ledger_seconds'] = elapsed(bound_at, prepared)
            if not cached:
                metrics['upstream_request_lifetime_union_seconds'] = union_seconds(transfer.get('requests', []))
            attempt.update(stage_times=stage_times, render_receipt_reused=cached, asr_receipt_reused=asr_cached,
                artifact_directory=artifact.get('directory'), render_created_at=result.get('created_at'),
                asr_completed_at=asr_finished, asr_bound_at=bound_at,
                provider={k: provider.get(k) for k in ('engine', 'model', 'device', 'compute_type')},
                duration_seconds=result.get('duration_seconds'), metrics=metrics,
                missing_measurements=[key for key, value in metrics.items() if value is None])
        prepared = any('prepared' in a['stage_times'] for a in attempts)
        settled = prepared or any('failed' in a['stage_times'] or 'awaiting_astra' in a['stage_times'] for a in attempts)
        return {'candidate_id': vid, 'lane': lane, 'admitted': bool(attempts),
            'preparation_status': 'prepared' if prepared else 'failed_or_deferred' if settled else 'in_progress' if attempts else 'not_started',
            'attempts': attempts, 'artifact_directories': [a['directory'] for a in artifacts]}

    def run(self):
        base, plan, status = self.experiment_files()
        ids = plan.get('candidate_ids', [])
        if len(ids) != 50 or len(set(ids)) != 50:
            self.errors.append({'error': 'Frozen experiment must contain exactly 50 unique IDs'})
        lanes = {vid: s.get('lane') for s in plan.get('slots', []) for vid in s.get('candidate_ids', [])}
        start, finish = status.get('preparation_started_at'), status.get('preparation_finished_at')
        events, paths = self.stages(set(ids), start or status.get('started_at'), finish, base)
        rows = [self.candidate(vid, lanes.get(vid), events.get(vid, [])) for vid in ids]
        attempts = [attempt for row in rows for attempt in row['attempts']]
        metrics = {key: summary([a['metrics'][key] for a in attempts]) for key in DEFINITIONS}
        counts = dict(Counter(row['preparation_status'] for row in rows))
        barrier_seconds = elapsed(start, finish)
        observed_seconds = elapsed(start, finish or self.as_of)
        prepared_count = counts.get('prepared', 0)
        settled_count = prepared_count + counts.get('failed_or_deferred', 0)
        interval = {'started_at': start, 'finished_at': finish, 'observed_at': self.as_of,
            'complete': barrier_seconds is not None, 'barrier_wall_seconds': barrier_seconds,
            'elapsed_observed_seconds': observed_seconds,
            'prepared_candidates_per_hour_observed_batch_rate': prepared_count*3600/observed_seconds if observed_seconds else None,
            'settled_candidates_per_hour_observed_batch_rate': settled_count*3600/observed_seconds if observed_seconds else None,
            'scope': 'Observed end-to-end preparation of this fixed fifty, including admission order, queues and failures. Not steady streaming throughput.'}
        lane_metrics = {}
        for lane in sorted({row['lane'] for row in rows if row['lane']}):
            subset = [row for row in rows if row['lane'] == lane]
            lane_attempts = [a for row in subset for a in row['attempts']]
            lane_metrics[lane] = {'candidates': len(subset), 'counts': dict(Counter(r['preparation_status'] for r in subset)),
                'metrics': {key: summary([a['metrics'][key] for a in lane_attempts]) for key in DEFINITIONS}}
        report = {'schema_version': 'snippy-preparation-timing-v1', 'generated_at': self.as_of,
            'experiment_id': self.experiment_id, 'plan_path': str(base/'experiment-plan.json'),
            'status_path': str(base/'experiment-status.json'), 'runner_log_paths': paths,
            'candidate_count': len(ids), 'counts': counts, 'barrier': interval, 'metrics': metrics, 'lanes': lane_metrics,
            'metric_definitions': DEFINITIONS,
            'unmeasured': ['Pure GCS download duration (network reads overlap encoder work/backpressure)',
                'Render semaphore queue alone (mixed with validation/metadata/ledger residual)',
                'GPU ASR semaphore queue alone', 'GPU model startup versus inference duration',
                'GPU utilization or active kernel occupancy', 'Pure technical QA CPU time',
                'Steady streaming throughput (this run uses a full preparation barrier before ten Luna groups)'],
            'interpretation': 'Metric sums are per-candidate durations and may overlap across candidates or overlap other metrics. They must not be added to reconstruct barrier wall time.',
            'candidates': rows, 'integrity_passed': not self.errors, 'errors': self.errors,
            'final': barrier_seconds is not None and settled_count == len(ids)}
        audit.atomic(self.root/'preparation-timing.json', report)
        self.markdown(report)
        return report

    def markdown(self, report):
        barrier = report['barrier']
        lines = [f"# Preparation timing: {self.experiment_id}", '',
            f"Observed candidates: {report['candidate_count']}; stages: {json.dumps(report['counts'], sort_keys=True)}.",
            f"Preparation barrier: **{'complete' if barrier['complete'] else 'still running'}**; elapsed observed {barrier['elapsed_observed_seconds']} seconds.", '',
            'These are observed batch preparation timings. Steady streaming throughput and isolated GPU inference/queue time were not measured.', '',
            '| Metric | Measured attempts | Sum seconds | Median seconds | P90 seconds | Max seconds |',
            '|---|---:|---:|---:|---:|---:|']
        for name, row in report['metrics'].items():
            lines.append(f"| {name} | {row['measured_count']} | {row['sum_seconds']} | {row['median_seconds']} | {row['p90_seconds']} | {row['max_seconds']} |")
        lines += ['', report['interpretation'], '', 'Measurement boundaries:', '']
        lines += [f'- **{key}**: {value}' for key, value in DEFINITIONS.items()]
        lines += ['', 'Not separately measured:', ''] + ['- '+item for item in report['unmeasured']]
        lines += ['', 'Per-candidate stages, source log line numbers, artifact paths, cache reuse, and lane statistics: [preparation-timing.json](preparation-timing.json).', '']
        path = self.root/'preparation-timing.md'
        temp = path.with_suffix('.md.tmp')
        temp.write_text('\n'.join(lines), encoding='utf-8')
        temp.replace(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--experiment-id', required=True)
    args = parser.parse_args(argv)
    report = PreparationTiming(args.root, args.experiment_id).run()
    print(json.dumps({'experiment_id': report['experiment_id'], 'counts': report['counts'],
        'barrier': report['barrier'], 'integrity_passed': report['integrity_passed'], 'final': report['final']}))
    return 0 if report['integrity_passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
