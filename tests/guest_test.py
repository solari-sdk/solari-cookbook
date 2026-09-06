"""Synthetic local tests; contributor repositories are never executed here."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]

def invoke(payload, revisions=None):
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    command = [sys.executable, str(ROOT / 'guest/runner.py'), encoded]
    if revisions is not None:
        # Substitute only Git transport at its external seam; no contributor code or network.
        wrapper = '''import importlib.util, sys, json
spec = importlib.util.spec_from_file_location('guest', sys.argv[1])
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
original = guest.command
revisions = iter(json.loads(sys.argv[3]))
def fake_git(argv, root, seconds):
    if argv[0] != 'git':
        return original(argv, root, seconds)
    return {'exitCode': 0, 'stdout': next(revisions) if argv[1] == 'rev-parse' else '', 'stderr': '', 'timedOut': False, 'truncated': False, 'durationMs': 0}
guest.command = fake_git
sys.argv = [sys.argv[1], sys.argv[2]]
guest.main()
'''
        command = [sys.executable, '-c', wrapper, str(ROOT / 'guest/runner.py'), encoded, json.dumps(revisions)]
    result = subprocess.run(command,
                            capture_output=True, text=True, timeout=15)
    return json.loads(result.stdout)

def payload(code="print('CACHE_OK')"):
    return {'source': {'kind': 'fixture', 'baseline': {}, 'candidate': {}},
            'lane': 'baseline', 'setup': [], 'commandSeconds': 1,
            'probe': {'argv': [sys.executable, 'probe.py'], 'files': {'probe.py': code},
                      'expectedFailure': {'exitCode': 1, 'contains': 'STALE_READ'},
                      'expectedSuccess': {'contains': 'CACHE_OK'}}}

class GuestTest(unittest.TestCase):
    def test_git_revision_changes_during_setup_or_probe_are_rejected(self):
        data = payload()
        data['source'] = {'kind': 'git', 'url': 'https://github.com/example/repo',
                          'baseline': 'a'*40, 'candidate': 'b'*40}
        for revisions, probe_ran in [(['b'*40], False), (['a'*40, 'b'*40], False), (['a'*40, 'a'*40, 'b'*40], True)]:
            result = invoke(data, revisions)
            self.assertIn('revision does not match', result['error'])
            self.assertEqual(result['revision'], 'b'*40)
            self.assertEqual(result['probe'] is not None, probe_ran)

    def test_actual_probe_digest_and_modification_detection(self):
        data = payload("print('CACHE_OK')\n")
        expected = hashlib.sha256(json.dumps([data['probe']['argv'], [['probe.py', hashlib.sha256(b"print('CACHE_OK')\n").hexdigest()]]], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(invoke(data)['probeSha256'], expected)
        data = payload("open('probe.py', 'a').write('# changed'); print('CACHE_OK')")
        self.assertIn('probe files changed', invoke(data)['error'])

    def test_large_setup_artifact_and_bounded_probe_output(self):
        data = payload("from pathlib import Path; assert Path('artifact').stat().st_size == 2097152; print('x'*2000000)")
        data['setup'] = [{'argv': [sys.executable, '-c', "open('artifact','wb').write(b'x'*2097152)"]}]
        result = invoke(data)
        self.assertIsNone(result['error'])
        self.assertEqual(result['probe']['exitCode'], 0)
        self.assertEqual(len(result['probe']['stdout']), 8192)
        self.assertTrue(result['probe']['truncated'])

    def test_empty_non_executable_argument_is_preserved(self):
        data = payload()
        data['probe']['argv'] = [sys.executable, '-c', 'import sys; print(repr(sys.argv[1]))', '']
        self.assertEqual(invoke(data)['probe']['stdout'].strip(), "''")

    def test_environment_is_not_inherited(self):
        os.environ['PATCHPROOF_TEST_SECRET'] = 'not-for-guest'
        try:
            result = invoke(payload("import os; print(os.environ.get('PATCHPROOF_TEST_SECRET', 'ABSENT'))"))
            self.assertEqual(result['probe']['stdout'].strip(), 'ABSENT')
        finally:
            del os.environ['PATCHPROOF_TEST_SECRET']

    def test_git_rejects_unpinned_revision_before_execution(self):
        data = payload()
        data['source'] = {'kind': 'git', 'url': 'https://github.com/example/repo',
                          'baseline': 'main', 'candidate': 'a'*40}
        result = invoke(data)
        self.assertIn('full commit hash', result['error'])
        self.assertIsNone(result['revision'])
        self.assertIsNone(result['probe'])

    @unittest.skipUnless(os.name == 'posix', 'Linux symlink behavior requires Linux')
    def test_setup_symlink_cannot_redirect_reviewer_files(self):
        data = payload()
        data['setup'] = [{'argv': [sys.executable, '-c', "import os; os.symlink('/tmp', 'outside')"]}]
        data['probe']['files'] = {'outside/probe.py': 'print(1)'}
        self.assertIn('symlink', invoke(data)['error'])

    def test_cache_manifests_detect_fixed_and_unfixed_candidates(self):
        for name, candidate_exit, candidate_witness in [('cache-fix', 0, 'CACHE_OK'), ('cache-unfixed', 1, 'STALE_READ')]:
            manifest = json.loads((ROOT / 'fixtures' / (name + '.json')).read_text())
            digests = []
            for lane, exit_code, witness in [('baseline', 1, 'STALE_READ'), ('candidate', candidate_exit, candidate_witness)]:
                data = {key: manifest[key] for key in ('source', 'setup', 'probe')}
                data.update(lane=lane, commandSeconds=1)
                data['probe']['argv'][0] = sys.executable
                result = invoke(data)
                self.assertIsNone(result['error'])
                self.assertEqual(result['probe']['exitCode'], exit_code)
                self.assertIn(witness, result['probe']['stdout'])
                digests.append(result['probeSha256'])
            self.assertEqual(digests[0], digests[1])

    def test_probe_files_replace_setup_content(self):
        data = payload()
        data['setup'] = [{'argv': [sys.executable, '-c', "open('probe.py','w').write('raise SystemExit(7)')"]}]
        self.assertEqual(invoke(data)['probe']['exitCode'], 0)

    def test_rejects_unsafe_paths_and_malformed_payloads(self):
        for path in ['../escape', '/absolute', 'C:/absolute', '.git/config', 'x/../../escape', 'x\\escape', 'x/__proto__/y', 'non ascii', 'a'*201]:
            data = payload()
            data['probe']['files'] = {path: 'bad'}
            self.assertTrue(invoke(data)['error'], path)
        data = payload()
        data['setup'] = [{'argv': ['echo']}]*6
        self.assertTrue(invoke(data)['error'])
        data = payload()
        data['probe']['files'] = {str(i): '' for i in range(33)}
        self.assertTrue(invoke(data)['error'])
        data = payload()
        data['env'] = {'SECRET': 'bad'}
        self.assertTrue(invoke(data)['error'])

    def test_timeout_and_output_cap(self):
        result = invoke(payload('import time; time.sleep(5)'))
        self.assertTrue(result['probe']['timedOut'])
        result = invoke(payload("import sys; print('x'*20000); print('y'*20000, file=sys.stderr)"))
        self.assertTrue(result['probe']['truncated'])
        self.assertEqual(len(result['probe']['stdout']), 8192)
        self.assertEqual(len(result['probe']['stderr']), 8192)

    def test_setup_failure_stops_probe(self):
        data = payload()
        data['setup'] = [{'argv': [sys.executable, '-c', 'raise SystemExit(3)']}]
        result = invoke(data)
        self.assertEqual(result['setup'][0]['exitCode'], 3)
        self.assertIsNone(result['probe'])
        self.assertTrue(result['error'])

    def test_probe_runs_and_reports_runtime(self):
        result = invoke(payload())
        self.assertIsNone(result['error'])
        self.assertEqual(result['probe']['exitCode'], 0)
        self.assertEqual(result['probe']['stdout'].strip(), 'CACHE_OK')
        self.assertEqual(result['protocol'], 1)
        self.assertTrue(result['runtime']['python'])

if __name__ == '__main__':
    unittest.main()

