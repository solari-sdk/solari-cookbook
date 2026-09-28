// SPDX-License-Identifier: AGPL-3.0-only
// The agents the wireframe fixture puts on a computer, for the shot of a line
// that fills both of its lines. Every name is the catalog's own, cycled to fill
// the list: the screens that name agents name them by their catalog names, so a
// shot of one may not carry an agent the product does not have.
import { CATALOG_AGENTS } from "@wsp/catalog";
import type { InitAgent } from "@wsp/protocol";

export function manyAgents(count: number): InitAgent[] {
  return Array.from({ length: count }, (_, at) => {
    const entry = CATALOG_AGENTS[at % CATALOG_AGENTS.length]!;
    return { id: `${entry.id}-${at}`, name: entry.name, configured: true, takesTools: true };
  });
}
