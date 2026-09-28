// SPDX-License-Identifier: AGPL-3.0-only
// The backend a host wires when this computer has no machine provider key:
// wsp init took the local road, so this computer is a workspace and nothing
// else exists to fork. It sits behind the same MachineBackend seam the Solari
// and local backends do, so nothing above the registry learns there is no
// provider; every capability is false, so every road that reads one refuses
// before it reaches here, and the roads that ask anyway get one sentence
// naming what to do rather than a provider's 401. The refusal is typed, so a
// host reading its records at start can tell a machine nobody can be asked
// about from a machine the provider says is gone: the first waits for the key,
// the second is really gone.

import { NO_PROVIDER_LINE } from "@wsp/protocol";
import type { Capabilities } from "@wsp/protocol";
import type { BackendPricing, Machine, MachineBackend, MachineState, SnapshotStoragePricing } from "./machine.js";

const NO_SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" };

/** What every road on a host with no provider key refuses with. Nothing is wrong with the machine: the key is what
 * is missing, and the record waits for it rather than being called gone. */
export class NoProviderError extends Error {
  readonly kind = "noProvider" as const;
  constructor() {
    super(NO_PROVIDER_LINE);
    this.name = "NoProviderError";
  }
}

export function isNoProvider(e: unknown): boolean {
  return (e as { kind?: unknown } | undefined)?.kind === "noProvider";
}

const refuse = (): never => {
  throw new NoProviderError();
};

/** The provider module of a host with no provider key: it holds no machine, lists none, and refuses every road with
 * the one sentence that says how to get one. */
export class NoProviderBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: false,
    replacesMachine: false, // nothing here forks, so there is no machine to hand a workspace in place of another
    previewUrls: false,
    signedUrls: false,
    callbackRelay: false,
    diskSnapshots: false,
    images: false, // no provider, so no image either
    snapshotsAnyLife: false,
    snapshotListing: false,
    templates: false,
    sizes: [],
    kept: false,
    // Nothing here forks and nothing here copies: the host has no provider, so there is nothing to copy onto.
    copies: false,
    ownNetwork: false,
  };

  readonly pricing: BackendPricing = {
    rateUsdPerHour: () => 0,
    defaultSize: { cpu: 0, memMb: 0 },
    snapshotStorage: NO_SNAPSHOT_STORAGE,
  };

  async create(): Promise<Machine> {
    return refuse();
  }

  async get(): Promise<Machine> {
    return refuse();
  }

  async list(): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    return [];
  }

  async deleteSnapshot(): Promise<void> {
    return refuse();
  }
}
