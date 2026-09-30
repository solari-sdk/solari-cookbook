import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { BisectEvent } from '../bisect/bisect.ts';
import { shortId } from '../report/replay.ts';

/** The request context the SDK passes to a tool handler. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Sends MCP progress notifications when the client asked for them (a progressToken). Replays take
 * a minute or more; progress also keeps clients that reset their timeout on progress from giving up.
 */
export function progressReporter(extra: ToolExtra): (message: string) => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => {};
  let progress = 0;
  return (message) => {
    progress += 1;
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, message },
      })
      .catch(() => {});
  };
}

/** The same milestones the CLI prints on stderr; guest output is left out. */
export function describeEvent(report: (message: string) => void): (event: BisectEvent) => void {
  return (event) => {
    if (event.type === 'baseline-start') report('first run without the fix');
    else if (event.type === 'machine') report(`machine ${shortId(event.id)} ready`);
    else if (event.type === 'step-start') report(event.step.title);
    else if (event.type === 'attempt-start') report(`attempt ${event.index + 1}/${event.total}`);
    else if (event.type === 'trial-start') {
      report(`trial ${event.index + 1}: ${event.atoms.join(' + ') || 'good environment'}`);
    } else if (event.type === 'trial-end')
      report(`trial ${event.index + 1}: ${event.trial.result}`);
  };
}
