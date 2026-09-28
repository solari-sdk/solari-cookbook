// SPDX-License-Identifier: AGPL-3.0-only
// The port a workspace's apps bind on a computer whose copies share its
// network. Every copy of a project folder on this computer is one process tree
// on one loopback, so two dev servers that both read 3000 are one port and the
// second one fails to bind. Each copy is handed a base of its own instead, in
// the hidden range above what a person's own shell would use, and the row says
// the ports are shared so nobody is surprised by it. Nothing probes a port:
// what a running app does with the base is the app's, and two copies whose
// servers both hardcode 3000 is the named limit rather than something guessed
// around.
import { PORT_BASE_FIRST, PORT_BASE_STEP } from "@wsp/protocol";

/** The last base the range holds: the highest one a step apart from the first that still leaves a whole step of
 * ports under the ceiling. Past it there is no port left to bind, which is six hundred copies on one computer and
 * a wall worth a sentence rather than a number no app can listen on. */
export const PORT_BASE_LAST = PORT_BASE_FIRST + Math.floor((65535 - PORT_BASE_STEP - PORT_BASE_FIRST) / PORT_BASE_STEP) * PORT_BASE_STEP;

export const NO_PORT_BASE_LEFT = `every port base from ${PORT_BASE_FIRST} to ${PORT_BASE_LAST} is held; delete a workspace here first`;

/** The first base no copy on this computer holds: 3100, then 3200, in steps, counting from the first free one
 * rather than from the highest taken, so a base freed by a delete is handed out again. */
export function nextPortBase(taken: readonly number[]): number {
  const held = new Set(taken);
  for (let base = PORT_BASE_FIRST; base <= PORT_BASE_LAST; base += PORT_BASE_STEP) {
    if (!held.has(base)) return base;
  }
  throw new Error(NO_PORT_BASE_LEFT);
}
