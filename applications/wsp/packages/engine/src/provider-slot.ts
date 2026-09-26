// SPDX-License-Identifier: AGPL-3.0-only
// One backend the runtime holds for the life of a host, standing in front of
// whichever provider module is current. A host that started with no key
// serves this computer alone behind NoProviderBackend; when the init job
// saves a key the slot swaps to the real module, and every road the runtime
// already wired reads the new one on its next call.
import type { MachineBackend } from "./machine.js";

export interface ProviderSlot {
  /** What the runtime is wired with: every read and call lands on the module current at that moment. */
  readonly backend: MachineBackend;
  swap(next: MachineBackend): void;
  current(): MachineBackend;
}

export function providerSlot(initial: MachineBackend): ProviderSlot {
  let target = initial;
  // A method read off the slot is a forwarder, so a caller that kept it before a swap still reaches the current module.
  const forwarders = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const backend = new Proxy({} as MachineBackend, {
    get(_, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      let forwarder = forwarders.get(prop);
      if (forwarder === undefined) {
        forwarder = (...args: unknown[]) => (Reflect.get(target, prop) as (...a: unknown[]) => unknown).apply(target, args);
        forwarders.set(prop, forwarder);
      }
      return forwarder;
    },
    has(_, prop) {
      return prop in target;
    },
    ownKeys() {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      const own = Reflect.getOwnPropertyDescriptor(target, prop);
      return own === undefined ? undefined : { ...own, configurable: true };
    },
  });
  return {
    backend,
    swap(next) {
      target = next;
    },
    current: () => target,
  };
}
