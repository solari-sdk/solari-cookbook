"""Fixed guest entrypoint. Normal use executes exclusively inside a disposable VM."""
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time


def keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError('invalid object fields')


def files(value):
    if not isinstance(value, dict) or len(value) > 32:
        raise ValueError('invalid files')
    for path, content in value.items():
        if (not isinstance(path, str) or len(path) > 200 or
                not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_./-]*', path) or
                any(part in ('', '.', '..', '.git', '__proto__') for part in path.split('/')) or
                not isinstance(content, str) or len(content.encode()) > 65536):
            raise ValueError('unsafe file path or content')


def argv(value):
    if (not isinstance(value, list) or not 1 <= len(value) <= 64 or
            any(not isinstance(arg, str) or (i == 0 and not arg) or len(arg) > 8192 or '\x00' in arg for i, arg in enumerate(value))):
        raise ValueError('invalid command argv')


def validate(data):
    keys(data, ['source', 'lane', 'setup', 'probe', 'commandSeconds'])
    if data['lane'] not in ('baseline', 'candidate') or type(data['commandSeconds']) is not int or not 1 <= data['commandSeconds'] <= 120:
        raise ValueError('invalid lane or timeout')
    source = data['source']
    if not isinstance(source, dict):
        raise ValueError('invalid source')
    if source.get('kind') == 'fixture':
        keys(source, ['kind', 'baseline', 'candidate'])
        files(source['baseline'])
        files(source['candidate'])
    elif source.get('kind') == 'git':
        keys(source, ['kind', 'url', 'baseline', 'candidate'])
        if not isinstance(source['url'], str) or not re.fullmatch(r'https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', source['url']):
            raise ValueError('invalid public GitHub URL')
        for lane in ('baseline', 'candidate'):
            if not isinstance(source[lane], str) or not re.fullmatch('[0-9a-fA-F]{40}', source[lane]):
                raise ValueError('revision must be a full commit hash')
    else:
        raise ValueError('invalid source kind')
    if not isinstance(data['setup'], list) or len(data['setup']) > 5:
        raise ValueError('invalid setup')
    for step in data['setup']:
        keys(step, ['argv'])
        argv(step['argv'])
    probe = data['probe']
    keys(probe, ['argv', 'files', 'expectedFailure', 'expectedSuccess'])
    argv(probe['argv'])
    files(probe['files'])
    keys(probe['expectedFailure'], ['exitCode', 'contains'])
    keys(probe['expectedSuccess'], ['contains'])
    if type(probe['expectedFailure']['exitCode']) is not int or not 1 <= probe['expectedFailure']['exitCode'] <= 255:
        raise ValueError('invalid expected failure')
    for witness in (probe['expectedFailure']['contains'], probe['expectedSuccess']['contains']):
        if not isinstance(witness, str) or not 1 <= len(witness) <= 1024:
            raise ValueError('invalid witness')


def materialize(root, contents):
    for name, content in contents.items():
        target = root / name
        for parent in [target, *target.parents]:
            if parent == root:
                break
            if parent.is_symlink():
                raise ValueError('symlink in file path')
        if not target.resolve().is_relative_to(root.resolve()):
            raise ValueError('file escapes workspace')
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('w', encoding='utf-8', newline='') as output:
            output.write(content)


def probe_digest(root, probe):
    file_hashes = []
    for name in sorted(probe['files']):
        with (root / name).open('rb') as source:
            content = source.read(65537)
        if len(content) > 65536:
            raise ValueError('probe files changed beyond allowed size')
        file_hashes.append([name, hashlib.sha256(content).hexdigest()])
    evidence = [probe['argv'], file_hashes]
    return hashlib.sha256(json.dumps(evidence, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def check_revision(root, expected, seconds, result):
    output = command(['git', 'rev-parse', 'HEAD'], root, seconds)
    actual = output['stdout'].strip()
    result['revision'] = actual if re.fullmatch('[0-9a-f]{40}', actual) else None
    if output['exitCode'] or output['timedOut'] or output['truncated'] or actual != expected:
        raise ValueError('checked out revision does not match requested hash')


def resource_limits():
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def command(argv, root, seconds):
    start = time.monotonic()
    resolved = list(argv)
    if os.name == 'nt' and resolved and resolved[0] == 'python3':
        resolved[0] = sys.executable
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(root),
                   'LANG': 'C.UTF-8', 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1'}
    if os.name == 'nt':  # Synthetic fixture tests only.
        environment['SystemRoot'] = os.environ.get('SystemRoot', 'C:\\Windows')
        environment['PATH'] = os.environ.get('PATH', environment['PATH'])
    process = subprocess.Popen(resolved, cwd=root, stdin=subprocess.DEVNULL, env=environment,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=os.name == 'posix',
                               preexec_fn=resource_limits if os.name == 'posix' else None)
    buffers = [bytearray(), bytearray()]
    stop = threading.Event()
    reader_errors = []

    def drain(stream, buffer):
        # On POSIX, non-blocking reads let cleanup stop even if a detached descendant
        # holds the pipe open. On Windows, blocking reads are safe: the pipe closes
        # when the process exits and CreateFile semantics differ from POSIX.
        try:
            if os.name == 'posix':
                os.set_blocking(stream.fileno(), False)
                while not stop.is_set():
                    try:
                        chunk = os.read(stream.fileno(), 65536)
                    except BlockingIOError:
                        stop.wait(0.005)
                        continue
                    if not chunk:
                        break
                    buffer.extend(chunk[:max(0, 32772 - len(buffer))])
            else:
                while True:
                    chunk = stream.read(65536)
                    if not chunk:
                        break
                    buffer.extend(chunk[:max(0, 32772 - len(buffer))])
        except OSError as error:
            reader_errors.append(str(error))
        finally:
            stream.close()

    readers = [threading.Thread(target=drain, args=(stream, buffer))
               for stream, buffer in zip((process.stdout, process.stderr), buffers)]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait()
    finally:
        if os.name == 'posix':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for reader in readers:
            reader.join(timeout=0.5)
        incomplete = any(reader.is_alive() for reader in readers)
        stop.set()
        for reader in readers:
            reader.join()
    out, err = [buffer.decode('utf-8', 'replace') for buffer in buffers]
    return {'exitCode': process.returncode, 'stdout': out[:8192],
            'stderr': err[:8192], 'timedOut': timed_out,
        'truncated': bool(reader_errors) or incomplete or len(out) > 8192 or len(err) > 8192,
            'durationMs': round((time.monotonic() - start) * 1000)}


def main():
    result = {'protocol': 1, 'revision': None, 'probeSha256': None,
              'runtime': {'python': platform.python_version(), 'platform': platform.platform()},
              'setup': [], 'probe': None, 'error': None}
    try:
        if len(sys.argv) != 2 or len(sys.argv[1]) > 1000000:
            raise ValueError('invalid payload size')
        data = json.loads(base64.b64decode(sys.argv[1], validate=True))
        validate(data)
        with tempfile.TemporaryDirectory(prefix='patchproof-') as directory:
            root = Path(directory)
            source = data['source']
            if source['kind'] == 'fixture':
                materialize(root, source[data['lane']])
            else:
                revision = source[data['lane']].lower()
                for arguments in [['init', '--quiet'],
                                  ['-c', 'http.followRedirects=false', 'fetch', '--depth=1', '--no-tags', source['url'], revision],
                                  ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', 'FETCH_HEAD']]:
                    output = command(['git', *arguments], root, data['commandSeconds'])
                    if output['exitCode'] or output['timedOut'] or output['truncated']:
                        raise ValueError('git checkout failed: ' + output['stderr'][:2048])
                check_revision(root, revision, data['commandSeconds'], result)
            for step in data['setup']:
                output = command(step['argv'], root, data['commandSeconds'])
                result['setup'].append(output)
                if output['exitCode'] != 0 or output['timedOut'] or output['truncated']:
                    raise ValueError('setup command failed')
            if source['kind'] == 'git':
                check_revision(root, revision, data['commandSeconds'], result)
            materialize(root, data['probe']['files'])
            result['probeSha256'] = probe_digest(root, data['probe'])
            result['probe'] = command(data['probe']['argv'], root, data['commandSeconds'])
            if source['kind'] == 'git':
                check_revision(root, revision, data['commandSeconds'], result)
            if probe_digest(root, data['probe']) != result['probeSha256']:
                raise ValueError('probe files changed during execution')
    except Exception as error:
        result['error'] = str(error)[:2048]
    print(json.dumps(result))


if __name__ == '__main__':
    main()
