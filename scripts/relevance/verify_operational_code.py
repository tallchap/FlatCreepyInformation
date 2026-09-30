#!/usr/bin/env python3
"""Static editorial invariants against the original baseline; no live operations.

Explicit output path required. Historical verification is never overwritten by
default. Dirty worktrees and declared runtime details are reported honestly;
the full operational pipeline/render/transport functions are allowed to differ.
"""
import argparse
import ast
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys

BASE = 'd27ca786acb72458e97167ee39d95d2dd22ef8a7'
PREFIX = 'scripts/relevance/'
PROMPTS = [PREFIX + name for name in ('luna-batch-qa-prompt.txt', 'luna-batch-verifier-prompt.txt',
                                     'snippy-triage-v1.txt', 'audit-addendum-v1.txt')]
CORE = [PREFIX + name for name in ('luna_batch_qa.py', 'production.py', 'publish_astra.py', 'process_astra.py')]
EDITORIAL = ('validate_threshold', 'release_gate', 'release_gate_passed', 'build_request', 'bind_request',
             'normalize', 'approval_receipt', 'current_package', 'finalizer_package', 'recheck',
             'validate_publication_metadata', 'validate_speaker', 'trim_plan', 'escalation')
CONSTANTS = ('MAX_PASSES', 'DEFAULT_MIN_RELEASE_CONFIDENCE', 'RELEASE_POLICY_VERSION', 'ESCALATION_REASONS')


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def ast_text(value):
    return ast.dump(value, include_attributes=False)


def function(tree, name):
    return next(node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)


def compare_ast(a, b):
    left, right = ast_text(a), ast_text(b)
    return {'ast_equal': left == right, 'base_ast_sha256': digest(left), 'current_ast_sha256': digest(right)}


def constant(tree, name):
    node = next(n for n in tree.body if isinstance(n, ast.Assign) and
                any(isinstance(target, ast.Name) and target.id == name for target in n.targets))
    return ast.literal_eval(node.value)


def schema(tree):
    """Evaluate only the literal schema-construction block with tightly bounded calls."""
    begin = next(i for i, n in enumerate(tree.body) if isinstance(n, ast.Assign) and
                 any(isinstance(t, ast.Name) and t.id == 'ESCALATION_REASONS' for t in n.targets))
    end = next(i for i, n in enumerate(tree.body) if isinstance(n, ast.Assign) and
               any(isinstance(t, ast.Name) and t.id == 'SCHEMA' for t in n.targets))
    block = ast.Module(body=tree.body[begin:end + 1], type_ignores=[])
    allowed = (ast.Module, ast.Assign, ast.Expr, ast.For, ast.Name, ast.Constant, ast.List, ast.Tuple,
               ast.Dict, ast.Subscript, ast.Load, ast.Store, ast.Call, ast.Attribute, ast.keyword)
    for node in ast.walk(block):
        if not isinstance(node, allowed):
            raise ValueError('Unexpected executable node in schema construction: ' + type(node).__name__)
        if isinstance(node, ast.Call):
            target = node.func
            if not (isinstance(target, ast.Name) and target.id == 'list' or
                    isinstance(target, ast.Attribute) and target.attr == 'update' and
                    isinstance(target.value, ast.Name) and target.value.id == 'PROPS'):
                raise ValueError('Unapproved call in schema construction')
    namespace = {'__builtins__': {'list': list}}
    exec(compile(block, '<schema-only>', 'exec'), namespace)
    return block, namespace['SCHEMA']


def is_stop_call(node):
    return isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'check_stop'


def role_sections(tree):
    body = [n for n in function(tree, 'review_packages').body if not is_stop_call(n)]
    bind = next(i for i, n in enumerate(body) if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
                and isinstance(n.value.func, ast.Name) and n.value.func.id == 'bind_request')
    normalize = next(i for i, n in enumerate(body) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call)
                     and isinstance(n.value.func, ast.Name) and n.value.func.id == 'normalize')
    return (ast.Module(body=body[:bind + 1], type_ignores=[]),
            ast.Module(body=body[normalize:], type_ignores=[]))


def publication_guards(tree):
    return [ast_text(n) for n in function(tree, 'publish').body if isinstance(n, ast.If)]


def guards_preserved(base, current):
    position = 0
    for guard in current:
        if position < len(base) and base[position] == guard:
            position += 1
    return position == len(base)


def test_receipt(path):
    data = Path(path).read_bytes()
    text = data.decode('utf-8-sig', errors='replace')
    matches = list(re.finditer(r'^Ran (\d+) tests? in ([\d.]+)s\s*$', text, re.M))
    match = matches[-1] if matches else None
    tail = text[match.end():] if match else ''
    passed = bool(match and re.search(r'^OK(?:\s|\(|$)', tail, re.M) and not re.search(r'^FAILED\b', tail, re.M))
    return {'path': str(Path(path).resolve()), 'sha256': digest(data), 'parsed_unittest_result': bool(match),
        'test_count': int(match[1]) if match else None, 'elapsed_seconds': float(match[2]) if match else None,
        'passed': passed, 'executed_by_this_verifier': False,
        'scope': 'Observed captured log only; this parser cannot attest which source revision the test process loaded.'}


def verify(repo, base=BASE, private_env=None, require_clean=False, test_logs=(), runtime_commit=None, runtime_pid=None):
    repo = Path(repo).resolve()
    def git(*args, optional=False):
        result = subprocess.run(['git', '-C', str(repo), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode and not optional:
            raise ValueError('Git verification command failed: ' + ' '.join(args[:2]))
        return result.stdout if not result.returncode else None
    def git_text(*args, **kw):
        result = git(*args, **kw)
        return result.decode('utf-8', errors='replace').strip() if result is not None else None
    head = git_text('rev-parse', 'HEAD')
    base_sha = git_text('rev-parse', base)
    status_before = git_text('status', '--porcelain=v1', '--untracked-files=all').splitlines()
    tracked = git_text('ls-files').splitlines()
    source_paths = sorted(set(CORE + PROMPTS + [p for p in tracked if p.startswith(PREFIX) and p.endswith('.py')] +
                              [p.relative_to(repo).as_posix() for p in (repo / PREFIX).glob('*.py')]))
    source_hashes = {p: digest((repo / p).read_bytes()) for p in source_paths}
    prompts = []
    for path in PROMPTS:
        original, committed, current = git('show', base_sha + ':' + path), git('show', 'HEAD:' + path), (repo / path).read_bytes()
        # Same universal-newline read path used by the runtime's Path.read_text().
        runtime_text = (repo / path).read_text(encoding='utf-8')
        base_text = io.TextIOWrapper(io.BytesIO(original), encoding='utf-8').read()
        prompts.append({'path': path, 'base_sha256': digest(original), 'head_blob_sha256': digest(committed),
            'working_file_sha256': digest(current), 'runtime_text_sha256': digest(runtime_text),
            'base_head_git_blobs_identical': original == committed, 'working_bytes_identical': original == current,
            'runtime_read_text_identical': runtime_text == base_text,
            'working_difference_only_crlf': original.replace(b'\r\n', b'\n') == current.replace(b'\r\n', b'\n')})
    luna_path, publication_path = CORE[0], CORE[2]
    old = ast.parse(git('show', base_sha + ':' + luna_path).decode('utf-8-sig'))
    current = ast.parse((repo / luna_path).read_text(encoding='utf-8-sig'))
    editorial = {name: compare_ast(function(old, name), function(current, name)) for name in EDITORIAL}
    constants = {name: {'base': constant(old, name), 'current': constant(current, name),
                        'equal': constant(old, name) == constant(current, name)} for name in CONSTANTS}
    old_block, old_schema = schema(old)
    current_block, current_schema = schema(current)
    schema_result = {**compare_ast(old_block, current_block), 'evaluated_schema_equal': old_schema == current_schema,
        'base_schema_sha256': digest(json.dumps(old_schema, sort_keys=True)),
        'current_schema_sha256': digest(json.dumps(current_schema, sort_keys=True))}
    before_roles, after_roles = role_sections(old), role_sections(current)
    roles = {'request_and_role_prompt_selection': compare_ast(before_roles[0], after_roles[0]),
             'normalization_and_verifier_edit_ban': compare_ast(before_roles[1], after_roles[1])}
    old_pub = ast.parse(git('show', base_sha + ':' + publication_path).decode('utf-8-sig'))
    current_pub = ast.parse((repo / publication_path).read_text(encoding='utf-8-sig'))
    old_guards, current_guards = publication_guards(old_pub), publication_guards(current_pub)
    publication = {'base_guard_count': len(old_guards), 'current_guard_count': len(current_guards),
        'all_original_guards_preserved_in_order': guards_preserved(old_guards, current_guards),
        'full_function': compare_ast(function(old_pub, 'publish'), function(current_pub, 'publish'))}
    operational = {name: compare_ast(function(old, name), function(current, name)) for name in
                   ('pipeline', 'review_packages', 'ensure_asr', 'execute_trim')}
    private_env = Path(private_env).resolve() if private_env else repo.parent / 'private.env'
    tracked_private = [p for p in tracked if Path(p).name.lower() == 'private.env']
    tests = [test_receipt(path) for path in test_logs]
    status_after = git_text('status', '--porcelain=v1', '--untracked-files=all').splitlines()
    stable_files = all((repo / p).is_file() and digest((repo / p).read_bytes()) == h for p, h in source_hashes.items())
    snapshot_stable = head == git_text('rev-parse', 'HEAD') and status_before == status_after and stable_files
    clean = not status_after
    checks = {
        'four_prompt_git_blobs_unchanged': all(p['base_head_git_blobs_identical'] for p in prompts),
        'four_runtime_prompt_strings_unchanged': all(p['runtime_read_text_identical'] for p in prompts),
        'prompt_byte_differences_only_checkout_newlines': all(p['working_difference_only_crlf'] for p in prompts),
        'schema_construction_ast_unchanged': schema_result['ast_equal'],
        'evaluated_schema_unchanged': schema_result['evaluated_schema_equal'],
        'editorial_functions_ast_unchanged': all(v['ast_equal'] for v in editorial.values()),
        'request_roles_and_post_response_gates_unchanged': all(v['ast_equal'] for v in roles.values()),
        'policy_constants_unchanged': all(v['equal'] for v in constants.values()),
        'max_passes_exactly_five': constants['MAX_PASSES']['base'] == constants['MAX_PASSES']['current'] == 5,
        'release_threshold_exactly_point95': constants['DEFAULT_MIN_RELEASE_CONFIDENCE']['base'] == constants['DEFAULT_MIN_RELEASE_CONFIDENCE']['current'] == .95,
        'original_publication_guards_preserved': bool(old_guards) and publication['all_original_guards_preserved_in_order'],
        'private_env_outside_repository': not private_env.is_relative_to(repo),
        'private_env_untracked': not tracked_private,
        'source_snapshot_stable_during_verification': snapshot_stable,
        'provided_test_logs_report_success': all(t['passed'] for t in tests),
    }
    if require_clean:
        checks['working_tree_clean_required'] = clean
    return {'schema_version': 'snippy-operational-code-verification-v2',
        'created_at': datetime.now(timezone.utc).isoformat(), 'repository': str(repo),
        'base_commit': base_sha, 'head_commit': head, 'origin_tracking_commit': git_text('rev-parse', '@{upstream}', optional=True),
        'git_status_porcelain': status_after, 'working_tree_clean': clean, 'require_clean': require_clean,
        'current_source_sha256': source_hashes, 'prompts': prompts, 'schema': schema_result, 'constants': constants,
        'editorial_functions': editorial, 'role_binding': roles, 'publication_guards': publication,
        'operational_function_diagnostics': operational,
        'operational_scope': 'Orchestration, STOP, persistent ASR, transport, range caching and rendering changes are allowed. Full pipeline/render/transport AST equality is not asserted or required.',
        'private_environment': {'path': str(private_env), 'tracked_private_env_paths': tracked_private, 'contents_read': False},
        'runtime': {'declared_commit': runtime_commit, 'declared_pid': runtime_pid,
            'attestation': 'On-disk working-tree source only. Optional commit/PID are caller declarations; no live process memory or loaded-module attestation.'},
        'tests': tests, 'tests_executed_by_this_verifier': False,
        'checks': checks, 'passed': all(checks.values()),
        'limits': ['No historical test counts are inferred or promoted to this source revision.',
                   'No model, network, publishing, rendering or Relay calls were made.',
                   'Static invariant checks do not establish successful production outcomes or visual/audio quality.']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--base', default=BASE)
    parser.add_argument('--private-env', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--require-clean', action='store_true')
    parser.add_argument('--test-log', type=Path, action='append', default=[])
    parser.add_argument('--runtime-commit')
    parser.add_argument('--runtime-pid', type=int)
    args = parser.parse_args(argv)
    if args.output.exists():
        raise ValueError('Output already exists; preserve historical verification and choose a new receipt path')
    report = verify(args.repo, args.base, args.private_env, args.require_clean, args.test_log,
                    args.runtime_commit, args.runtime_pid)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(report, stream, indent=2, ensure_ascii=False)
        stream.write('\n')
    print(json.dumps({'report': str(args.output), 'passed': report['passed'], 'head_commit': report['head_commit'],
                      'working_tree_clean': report['working_tree_clean'], 'failed_checks': [k for k, v in report['checks'].items() if not v]}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
