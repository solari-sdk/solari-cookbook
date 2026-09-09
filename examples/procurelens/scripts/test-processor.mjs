import { spawnSync } from 'node:child_process';
const python = process.env.PROCURELENS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const run = spawnSync(python, ['tests/processor_test.py'], { stdio: 'inherit', timeout: 60000 });
if (run.error) console.error('Cannot start processor tests. Set PROCURELENS_PYTHON to a Python 3 executable.');
process.exitCode = run.status ?? 1;
