import { spawnSync } from 'node:child_process';

const python = process.env.PATCHPROOF_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['tests/guest_test.py'], { stdio: 'inherit', timeout: 60000 });
if (result.error) console.error(`Guest tests could not start: ${result.error.message}. Set PATCHPROOF_PYTHON to a Python executable.`);
process.exitCode = result.status ?? 1;
