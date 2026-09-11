import type { Sandbox, Desktop } from '@solarisdk/sandbox';
import { envelope } from './evidence.ts';
export function route(requirement: string) {
  switch (requirement) {
    case 'SOURCE_OR_COMMAND_EXECUTION': return 'SANDBOX';
    case 'GUI_DESKTOP_OBSERVATION': return 'DESKTOP';
    case 'WEB_INTERACTION_OR_DOM': return 'BROWSER';
    case 'PERSISTENT_ARTIFACT_RETRIEVAL': return 'VOLUME';
    default: return 'UNSUPPORTED';
  }
}
/** Injected Browser page contract from official BrowserSession.newPage().
 * No browser dependency is installed or session created by this module. */
export interface BrowserPage { content(): Promise<string> }
export async function observeCommand(sandbox: Pick<Sandbox,'id'|'commands'>, command: string, args: string[]) {
  const r = await sandbox.commands.run(command, { args, timeoutMs: 30000 });
  return envelope({primitiveType:'SANDBOX',workerId:sandbox.id,sourceIdentity:JSON.stringify([command,args]),observationType:'COMMAND_RESULT',observedAt:new Date().toISOString()},Buffer.from(JSON.stringify(r)));
}
export async function observeDesktop(desktop: Pick<Desktop,'id'|'screenshot'>) {
  const bytes = await desktop.screenshot({format:'png'});
  return {bytes,evidence:envelope({primitiveType:'DESKTOP',workerId:desktop.id,sourceIdentity:'current-display',observationType:'SCREENSHOT',observedAt:new Date().toISOString()},bytes)};
}
export async function observeBrowser(page: BrowserPage, workerId: string, sourceIdentity: string) {
  const bytes = Buffer.from(await page.content());
  return {bytes,evidence:envelope({primitiveType:'BROWSER',workerId,sourceIdentity,observationType:'DOM',observedAt:new Date().toISOString()},bytes)};
}
/** One observation attempt only; missing adapter is explicitly unsupported. */
export async function schedule(requirement: string, adapters: Partial<Record<'SANDBOX'|'DESKTOP'|'BROWSER'|'VOLUME', () => Promise<unknown>>>) {
  const primitive = route(requirement);
  if (primitive === 'UNSUPPORTED' || !adapters[primitive]) return {status:'UNSUPPORTED',primitive};
  try { const observation = await adapters[primitive]!(); return {status:'OBSERVED_NOT_REQUIREMENT_PROVEN',primitive,observation}; }
  catch { return {status:'UNKNOWN',primitive}; }
}
