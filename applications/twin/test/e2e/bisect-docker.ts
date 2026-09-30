/**
 * End-to-end check of bisect with a Docker container as the machine.
 * Run: node test/e2e/bisect-docker.ts <failing.json> <passing.json> [--verbose]
 */
import { bisect } from '../../src/bisect/bisect.ts';
import { readCapsule } from '../../src/capsule/file.ts';
import { renderBisect } from '../../src/report/bisect.ts';
import { createStyle } from '../../src/report/style.ts';
import { DockerBackend } from './docker-backend.ts';

const [badPath, goodPath, ...rest] = process.argv.slice(2);
if (!badPath || !goodPath) {
  console.error('usage: node test/e2e/bisect-docker.ts <failing.json> <passing.json> [--verbose]');
  process.exit(2);
}
const verbose = rest.includes('--verbose');
const report = await bisect(
  await readCapsule(goodPath),
  await readCapsule(badPath),
  new DockerBackend(),
  {
    onEvent: (event) => {
      if (event.type === 'step-start') console.error(`twin: ${event.step.title}`);
      if (event.type === 'trial-start')
        console.error(`twin: trial ${event.index + 1}: ${event.atoms.join(' + ') || 'good'}`);
      if (event.type === 'output' && verbose) process.stderr.write(event.chunk);
    },
  },
);
console.log(renderBisect(report, createStyle(process.stdout.isTTY === true)));
process.exitCode = report.verdict === 'found' ? 0 : 1;
