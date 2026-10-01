import ast
from pathlib import Path
import subprocess
import tempfile
import unittest

import verify_operational_code as verifier


class CodeVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        directory = self.repo / verifier.PREFIX
        directory.mkdir(parents=True)
        for prompt in verifier.PROMPTS:
            (self.repo / prompt).write_bytes(b'Exact editorial prompt.\nSecond line.\n')
        self.source = ('MAX_PASSES = 5\nDEFAULT_MIN_RELEASE_CONFIDENCE = .95\nRELEASE_POLICY_VERSION = "v1"\n'
            'ESCALATION_REASONS = ["uncertain"]\nIDENTITIES = ["candidate_id"]\nPROPS = {"id": {"type": "string"}}\n'
            'PROPS.update(status={"type": "string"})\n'
            'for key in ("picture", "dialogue"):\n    PROPS[key] = {"type": "string"}\n'
            'SCHEMA = {"type": "object", "required": list(PROPS), "properties": PROPS}\n')
        for name in verifier.EDITORIAL:
            self.source += f'\ndef {name}(*args, **kwargs):\n    return True\n'
        self.source += ('\ndef review_packages(packages, output, role="finalizer"):\n'
            '    body = build_request(packages)\n    if role == "verifier":\n        body["role"] = role\n'
            '    bind_request(body, packages)\n    raw = transport(body)\n'
            '    result = normalize(raw)\n    if role == "verifier":\n        forbid_edits(result)\n    return result\n')
        for name in ('pipeline', 'ensure_asr', 'execute_trim'):
            self.source += f'\ndef {name}():\n    return "operational"\n'
        (directory / 'luna_batch_qa.py').write_text(self.source)
        (directory / 'publish_astra.py').write_text('def publish():\n    if not verified:\n        raise ValueError("blocked")\n    return True\n')
        for name in ('production.py', 'process_astra.py'):
            (directory / name).write_text('# baseline operational code\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Verifier Test', '-c', 'user.email=verifier@example.invalid', 'commit', '-qm', 'fixture')
        self.base = self.git('rev-parse', 'HEAD').strip()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.DEVNULL, text=True)

    def verify(self, **kwargs):
        return verifier.verify(self.repo, base=self.base, **kwargs)

    def edit(self, before, after):
        path = self.repo / verifier.CORE[0]
        path.write_text(path.read_text().replace(before, after))

    def test_clean_static_receipt_has_no_invented_runtime_or_test_claims(self):
        report = self.verify(require_clean=True)
        self.assertTrue(report['passed'], report['checks'])
        self.assertTrue(report['working_tree_clean'])
        self.assertEqual(report['head_commit'], self.base)
        self.assertIsNone(report['runtime']['declared_pid'])
        self.assertEqual(report['tests'], [])
        self.assertFalse(report['tests_executed_by_this_verifier'])
        self.assertFalse(report['private_environment']['contents_read'])

    def test_operational_changes_are_reported_without_claiming_pipeline_ast_equal(self):
        self.edit('def pipeline():\n    return "operational"', 'def pipeline():\n    check_stop(output)\n    return "operational"')
        report = self.verify(runtime_commit=self.base, runtime_pid=123)
        self.assertTrue(report['passed'], report['checks'])
        self.assertFalse(report['working_tree_clean'])
        self.assertFalse(report['operational_function_diagnostics']['pipeline']['ast_equal'])
        self.assertIn('caller declarations', report['runtime']['attestation'])
        self.assertFalse(self.verify(require_clean=True)['passed'])

    def test_editorial_gate_or_constant_changes_fail(self):
        self.edit('DEFAULT_MIN_RELEASE_CONFIDENCE = .95', 'DEFAULT_MIN_RELEASE_CONFIDENCE = .90')
        self.edit('def normalize(*args, **kwargs):\n    return True', 'def normalize(*args, **kwargs):\n    return False')
        report = self.verify()
        self.assertFalse(report['passed'])
        self.assertFalse(report['checks']['release_threshold_exactly_point95'])
        self.assertFalse(report['checks']['editorial_functions_ast_unchanged'])

    def test_crlf_checkout_is_distinguished_from_changed_prompt_content(self):
        prompt = self.repo / verifier.PROMPTS[0]
        prompt.write_bytes(prompt.read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))
        report = self.verify()
        self.assertTrue(report['passed'], report['checks'])
        self.assertTrue(report['prompts'][0]['runtime_read_text_identical'])
        self.assertTrue(report['prompts'][0]['base_head_git_blobs_identical'])
        prompt.write_text('Changed editorial content.\n')
        self.assertFalse(self.verify()['passed'])

    def test_removed_publication_guard_and_tracked_private_env_fail(self):
        (self.repo / verifier.CORE[2]).write_text('def publish():\n    return True\n')
        (self.repo / 'private.env').write_text('DUMMY=test fixture\n')
        self.git('add', 'private.env')
        report = self.verify(private_env=self.repo / 'private.env')
        self.assertFalse(report['checks']['original_publication_guards_preserved'])
        self.assertFalse(report['checks']['private_env_outside_repository'])
        self.assertFalse(report['checks']['private_env_untracked'])

    def test_callable_decorator_preserves_audited_publication_guard_body(self):
        (self.repo / verifier.CORE[2]).write_text(
            'def publication_locked(function):\n'
            '    def locked(*args, **kwargs):\n'
            '        with publication_lock():\n'
            '            return function(*args, **kwargs)\n'
            '    return locked\n\n'
            '@publication_locked\n'
            'def publish():\n'
            '    if not verified:\n'
            '        raise ValueError("blocked")\n'
            '    if not current_scope:\n'
            '        raise ValueError("wrong scope")\n'
            '    return True\n')
        report=self.verify()
        self.assertTrue(report['checks']['original_publication_guards_preserved'],report['publication_guards'])
        self.assertEqual(report['publication_guards']['base_guard_count'],1)
        self.assertEqual(report['publication_guards']['current_guard_count'],2)

    def test_extra_stop_gate_does_not_change_role_binding_sections(self):
        self.edit('    body = build_request(packages)', '    check_stop(output)\n    body = build_request(packages)')
        self.assertTrue(self.verify()['checks']['request_roles_and_post_response_gates_unchanged'])

    def test_schema_evaluation_refuses_arbitrary_calls(self):
        bad = ast.parse('ESCALATION_REASONS=[]\n__import__("os").system("never")\nSCHEMA={}\n')
        with self.assertRaisesRegex(ValueError, 'Unapproved call'):
            verifier.schema(bad)

    def test_test_log_counts_are_parsed_only_from_actual_observed_summary(self):
        path = Path(self.temp.name) / 'tests.log'
        path.write_text('test_example ... ok\nRan 7 tests in 1.250s\n\nOK\n')
        report = self.verify(test_logs=[path])
        self.assertEqual(report['tests'][0]['test_count'], 7)
        self.assertTrue(report['passed'])
        path.write_text('Tests probably passed; 999 tests intended.\n')
        report = self.verify(test_logs=[path])
        self.assertIsNone(report['tests'][0]['test_count'])
        self.assertFalse(report['passed'])


if __name__ == '__main__':
    unittest.main()
