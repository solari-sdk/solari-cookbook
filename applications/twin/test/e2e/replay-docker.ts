/**
 * End-to-end check of capture + replay against a real public repo, with a Docker container as the
 * machine. Run: node test/e2e/replay-docker.ts <capsule.json>
 */
import { readCapsule } from '../../src/capsule/file.ts';
import { replay } from '../../src/replay/replay.ts';
import { renderReplay } from '../../src/report/replay.ts';
import { createStyle } from '../../src/report/style.ts';
import { DockerBackend } from './docker-backend.ts';

const [path, ...rest] = process.argv.slice(2);
if (!path) {
  console.error('usage: node test/e2e/replay-docker.ts <capsule.json> [--verbose]');
  process.exit(2);
}
const verbose = rest.includes('--verbose');
const capsule = await readCapsule(path);
const report = await replay(capsule, new DockerBackend(), {
  attempts: 2,
  onEvent: (event) => {
    if (event.type === 'step-start') console.error(`twin: ${event.step.title}`);
    if (event.type === 'output' && verbose) process.stderr.write(event.chunk);
  },
});
console.log(renderReplay(report, createStyle(process.stdout.isTTY === true)));
process.exitCode = report.verdict === 'reproduced' ? 0 : 1;
