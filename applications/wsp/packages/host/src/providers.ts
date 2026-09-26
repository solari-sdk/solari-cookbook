// SPDX-License-Identifier: AGPL-3.0-only
// Every machine provider this computer can be set up for, in one table: what
// selects each, the variable it reads its key from and the module it builds.
// The rows are read in order and the first that this computer answers to wins,
// so a person who names a provider gets it and a person who names none gets
// whatever their keys and their daemon say they have. Adding a provider is a
// row here and its backend in the engine; nothing above this file compares a
// provider by name.

import { BoxBackend, FakeBackend, NoProviderBackend, SolariBackend, type MachineBackend } from "@wsp/engine";
import { FAKE_AS_ENV, FAKE_RECORDS_ENV, FAKE_ROOT_ENV, PROVIDER_KEY_WORDS, standInRecordsPath } from "@wsp/protocol";
import type { PlaceBackends } from "@wsp/runtime";
import { keyIn } from "./env-keys.js";
import { fakeGuestAt } from "./fake-guest.js";

/** A word a harness set, or nothing where it set none: a variable set to nothing is a variable nobody set. */
const named = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value);

/** The environment a provider is picked out of: the host's own, with whatever the command line's provider words put
 * in front of it and every registered row's key variable filled from the layers a key is read through. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export interface ProviderModule {
  /** The word `--provider` takes and WSP_PROVIDER holds. */
  id: string;
  /** The variables this row selects on, so a host that starts with none of the installing shell's environment can
   * be handed them: `wsp up --service` copies whichever of them that shell held into the unit. Keys are not among
   * them: they stay out of a unit file, and the host reads them off the same .env at every start. */
  envNames: readonly string[];
  /** The variable this row reads its key from. Every layer a key is read through fills it, and the screen that
   * asks for a key says where to put it by this name. A row that needs no key names none, and names no key words
   * either: the two are declared together or not at all. */
  keyEnv?: string;
  /** That key in a person's words, which is what the screen asking for it is titled. */
  keyName?: string;
  /** Where a person gets that key, said on the screen that asks for it. */
  keyConsole?: string;
  /** Whether this computer is set up for this provider. */
  selects(env: ProviderEnv): boolean;
  /** The provider word this row's machines wear where it is not the row's own id; nothing where the row is what it
   * says it is. A stand-in answers here with the provider it stands in for, so a harness's rows read the cloud they
   * are serving in place of rather than the stand-in's own name. */
  standsFor?(env: ProviderEnv): string | undefined;
  build(env: ProviderEnv): MachineBackend;
}

/** The variable a person names a provider in, for a host started by a service or a window where no flag can reach. */
export const PROVIDER_ENV = "WSP_PROVIDER";

/** The row that holds no machine: what a host with no provider key is wired to, which is how a start knows to ask
 * no provider anything. */
export const NO_PROVIDER = "none";

/** The Box by ASCII key. */
export const BOX_KEY_ENV = "BOX_API_KEY";
/** The Solari key. */
export const SOLARI_KEY_ENV = "SOLARI_API_KEY";

export const PROVIDER_MODULES: readonly ProviderModule[] = [
  {
    id: "box",
    envNames: [PROVIDER_ENV],
    keyEnv: BOX_KEY_ENV,
    keyName: PROVIDER_KEY_WORDS["box"]!.keyName,
    keyConsole: PROVIDER_KEY_WORDS["box"]!.keyConsole,
    // Named alone: the word says which cloud this computer forks on, and a missing key is asked for by its own
    // variable on the key screen rather than guessed at here.
    selects: env => env[PROVIDER_ENV] === "box",
    build: env => new BoxBackend({ apiKey: env[BOX_KEY_ENV] ?? "" }),
  },
  {
    id: "fake",
    // No way of being added, so `wsp add` takes neither the word nor a key for it: a provider that answers out of
    // memory is a harness's fixture and never a place somebody owns. It is still a place to show while it stands
    // in for a cloud, since that is the cloud its machines read as being at.
    envNames: [PROVIDER_ENV, FAKE_AS_ENV, FAKE_ROOT_ENV, FAKE_RECORDS_ENV],
    // Named and never guessed: a provider that answers out of memory is what a harness serves a fixture state
    // through, so it is reached by asking for it by name and by nothing else. Two roads beyond a harness reach it,
    // both starting with the word typed: `wsp up --service` copies WSP_PROVIDER out of the installing shell into
    // the unit, and `wsp init --provider fake` would seal a hollow golden, since these machines answer exit 0 to
    // everything and the smoke gate reads an exit code.
    selects: env => env[PROVIDER_ENV] === "fake",
    // A fixture says which cloud it is standing in for, and its rows carry that word: a tester reading "fake" on
    // every row learns nothing about the provider the screen is meant to be showing them.
    standsFor: env => named(env[FAKE_AS_ENV]),
    // A folder for its machines where a harness named one: its records go there, so a second host on the same
    // state file finds the fleet the first one holds, and each machine gets a folder with a daemon in it. A
    // harness that seeds a fleet and drives none of it names the records file alone and its machines get no
    // guest. Neither named, and this is the stand-in it has always been, holding its machines for one process.
    build: env => {
      const root = named(env[FAKE_ROOT_ENV]);
      const records = root === undefined ? named(env[FAKE_RECORDS_ENV]) : standInRecordsPath(root);
      if (records === undefined) return new FakeBackend();
      return new FakeBackend({ records, ...(root === undefined ? {} : { guest: fakeGuestAt(root) }) });
    },
  },
  {
    id: "solari",
    envNames: [PROVIDER_ENV],
    keyEnv: SOLARI_KEY_ENV,
    keyName: PROVIDER_KEY_WORDS["solari"]!.keyName,
    keyConsole: PROVIDER_KEY_WORDS["solari"]!.keyConsole,
    // Named, or taken by its key alone: this is the cloud a computer that names no provider is offered, so a key
    // saved on its own is the whole answer.
    selects: env => env[PROVIDER_ENV] === "solari" || keyIn(env, SOLARI_KEY_ENV) !== undefined,
    build: env => new SolariBackend({ apiKey: env[SOLARI_KEY_ENV] ?? "" }),
  },
  {
    id: NO_PROVIDER,
    // No machine behind it, so no place to add and none to show: it is the row that refuses every road in one line.
    envNames: [],
    selects: () => true,
    build: () => new NoProviderBackend(),
  },
];

/** Every variable the rows select on, each once: what a service carries over from the shell that installed it, so
 * a provider added tomorrow travels with its row rather than with a list somebody remembered to edit. */
export function providerEnvNames(modules: readonly ProviderModule[] = PROVIDER_MODULES): string[] {
  return [...new Set(modules.flatMap(m => m.envNames))];
}

/** How a person adds this provider as a place, and nothing where it is no place at all: a row is added by the key
 * it declares the variable for, and a row that declares none is no place to add. `wsp add` reads this for which
 * words it takes, `wsp places` for whether the row is a place to show, and neither compares an id. One reading off
 * the row's own facts, and the one place a second road would be named. */
export function addedBy(m: ProviderModule): "key" | undefined {
  return m.keyEnv !== undefined ? "key" : undefined;
}

/** The providers a person can add as a place, in the table's own order: every row that answers for how it is added.
 * Read off the table, so a provider added tomorrow is on `wsp add`'s line without anyone editing that line. */
export function addedProviders(modules: readonly ProviderModule[] = PROVIDER_MODULES): ProviderModule[] {
  return modules.filter(m => addedBy(m) !== undefined);
}

/** Every variable a row reads its key from, each once: what the layers a key is read through fill. */
export function providerKeyEnvs(modules: readonly ProviderModule[] = PROVIDER_MODULES): string[] {
  return [...new Set(Object.values(providerKeyRows(modules)))];
}

/** The provider module this computer is set up for. */
export function providerModule(env: ProviderEnv, modules: readonly ProviderModule[] = PROVIDER_MODULES): ProviderModule {
  return modules.find(m => m.selects(env))!;
}

/** The word one row's machines and its place row are stamped with: the cloud it stands in for where it is a
 * stand-in, else its own id. Every reading of where a machine lives goes through here, so nothing compares a
 * provider id outside this table and the row a person reads cannot drift from the word its machines wear. */
export function placeIdOf(m: ProviderModule, env: ProviderEnv): string {
  return m.standsFor?.(env) ?? m.id;
}

/** The provider word this computer's own machines are stamped with. */
export function wiredProviderId(env: ProviderEnv, modules: readonly ProviderModule[] = PROVIDER_MODULES): string {
  return placeIdOf(providerModule(env, modules), env);
}

export function providerBackendFor(env: ProviderEnv): MachineBackend {
  return providerModule(env).build(env);
}

/** Whether this row is somewhere work can stand: a row somebody has added, or a stand-in wearing the cloud it is
 * serving in place of, whose machines are at that cloud as far as every screen goes. A row that is no place at all
 * says so on itself; nothing here compares an id.
 *
 * Added is read off the road the row declares. A row opened by a key is added once that key is here, since a row
 * whose key nobody has typed is one the provider would only refuse; before that it is a provider this computer
 * could be set up for and not one it is, and listing it put a second place on every screen beside the one the
 * person had connected, priced at the other one's rates.
 *
 * A stand-in counts because the screens a person reads are built from this: a harness serving a fixture of forks
 * at a cloud showed Settings with no provider row, New workspace with nowhere to create and the machines' own
 * cloud nowhere on the list they stood on. */
export function isPlace(m: ProviderModule, env: ProviderEnv): boolean {
  if (m.standsFor?.(env) !== undefined) return true;
  return m.keyEnv !== undefined && keyIn(env, m.keyEnv) !== undefined;
}

/** The provider this environment wires, as a place row priced off the backend it forks on; nothing where that row
 * is nowhere work can stand. The row wears the word its machines wear, so a stand-in shows the cloud it serves. */
export function wiredPlaceRow(env: ProviderEnv, backend: MachineBackend): { id: string; rateUsdPerHour: number } | undefined {
  const module = providerModule(env);
  if (!isPlace(module, env)) return undefined;
  const { pricing } = backend;
  return { id: placeIdOf(module, env), rateUsdPerHour: pricing.rateUsdPerHour(pricing.defaultSize) };
}

/** Every provider this computer is set up for, in the table's own order. These are the places a copy of the image
 * can be built at beyond the one this host forks on. */
export function placeProviders(env: ProviderEnv, modules: readonly ProviderModule[] = PROVIDER_MODULES): ProviderModule[] {
  return modules.filter(m => isPlace(m, env));
}

/** What a row reads out of the environment, as one string: every variable it declares and its key. A row whose
 * reading has changed is a different provider to reach, so the backend built on the old reading is not handed out
 * again; a key rotated while the host serves is the case this is for. */
const providerReading = (m: ProviderModule, env: ProviderEnv): string =>
  [...new Set([...m.envNames, ...(m.keyEnv !== undefined ? [m.keyEnv] : [])])].map(name => `${name}=${env[name] ?? ""}`).join("\n");

/** Where this host can build a copy of its image, as one table: the provider it forks on now, under the id of the
 * module it is wired with, and every other provider this computer is set up for. The wired row answers with the
 * runtime's own backend, so a key saved while the host serves moves it with everything else; every other row is
 * built at the first ask and kept while what it reads stands, since a module that holds its machines in memory
 * would lose them if this handed out a fresh one each time. Only the places a person can name are listed: a host
 * whose own module is no place lists the others and still answers for its own. */
export function providerPlaces(wired: () => string, backend: MachineBackend, env: () => ProviderEnv): PlaceBackends {
  const built = new Map<string, { reading: string; backend: MachineBackend }>();
  const rows = (): ProviderModule[] => placeProviders(env());
  return {
    get wired() {
      return wired();
    },
    backend: place => {
      if (place === wired()) return backend;
      const row = rows().find(m => placeIdOf(m, env()) === place);
      if (row === undefined) return undefined;
      const reading = providerReading(row, env());
      const held = built.get(row.id);
      if (held !== undefined && held.reading === reading) return held.backend;
      const made = row.build(env());
      built.set(row.id, { reading, backend: made });
      return made;
    },
    list: () => {
      // Each word once: a stand-in wearing a cloud this computer also holds a key for is two rows under one word,
      // and a list with the same place twice is a picker offering one machine two homes.
      const ids = [...new Set(rows().map(m => placeIdOf(m, env())))];
      return ids.includes(wired()) ? [wired(), ...ids.filter(id => id !== wired())] : ids;
    },
  };
}

/** Stands for any key at all, so a row can be asked which one it would be wired by without one being typed first. */
const ANY_KEY = "?";

/** The row a key typed on this computer is put to: the picked row when it reads a key, and otherwise the row that
 * holding a key would make the pick, so a computer set up for no provider is still offered the cloud a key alone
 * wires. Nothing when this computer is set up for a provider that reads no key. */
export function providerKeyRow(env: ProviderEnv, modules: readonly ProviderModule[] = PROVIDER_MODULES): ProviderModule | undefined {
  const picked = providerModule(env, modules);
  if (picked.keyEnv !== undefined) return picked;
  return modules.find(m => m.keyEnv !== undefined && providerModule({ ...env, [m.keyEnv]: ANY_KEY }, modules) === m);
}

/** The row a key being saved belongs to: the one named, else the row this computer would be wired by. Nothing where
 * no such row reads a key. */
function keyRowFor(env: ProviderEnv, provider: string | undefined, modules: readonly ProviderModule[]): { id: string; keyEnv: string } | undefined {
  const row = provider === undefined ? providerKeyRow(env, modules) : modules.find(m => m.id === provider);
  return row?.keyEnv === undefined ? undefined : { id: row.id, keyEnv: row.keyEnv };
}

/** What saving a key writes into the .env a host reads its own from: the variable the row that takes it reads, and
 * nothing else.
 * A key saved for a provider opens it as a place and leaves the provider this computer forks on where it was: a
 * second key is a second place, not a move of every workspace that comes after it. Nothing where no such row reads
 * a key. */
export function providerKeySet(env: ProviderEnv, key: string, provider?: string, modules: readonly ProviderModule[] = PROVIDER_MODULES): Record<string, string> | undefined {
  const row = keyRowFor(env, provider, modules);
  return row === undefined ? undefined : { [row.keyEnv]: key };
}

/** Every provider a key can be saved for, by the word WSP_PROVIDER holds and the variable that row reads its key
 * from. Read off the table, so a provider added tomorrow is a row there and nothing else. */
export function providerKeyRows(modules: readonly ProviderModule[] = PROVIDER_MODULES): Record<string, string> {
  return Object.fromEntries(modules.flatMap(m => (m.keyEnv === undefined ? [] : [[m.id, m.keyEnv] as const])));
}

/** The environment a key typed on this computer is checked in: under the variable the row that would take it reads,
 * and under the word that picks that row where one was named, so the provider the key is put to is the one it is
 * being saved for. This is the reading the check runs in and never what is written down. */
export function providerEnvWithKey(env: ProviderEnv, key: string, provider?: string, modules: readonly ProviderModule[] = PROVIDER_MODULES): ProviderEnv {
  const row = keyRowFor(env, provider, modules);
  if (row === undefined) return env;
  return { ...env, [row.keyEnv]: key, ...(provider === undefined ? {} : { [PROVIDER_ENV]: row.id }) };
}

/** The environment a run picks its provider out of: the host's own, the command line's words in front, and every
 * registered key variable taken from the first layer that holds it. The pick itself rides those same layers, so
 * the word wsp add wrote beside a state file is what the host serving it starts on; a stand-in's own variables are
 * not, since a fixture is named by the run that wants it. With no layers given the environment is the only one
 * there is, which is what a host started by a service reads. */
export function providerEnvWith(
  flags: { provider?: string },
  env: ProviderEnv = process.env,
  layers: readonly ProviderEnv[] = [env],
): ProviderEnv {
  const keys = providerKeyEnvs().flatMap(name => {
    const value = layers.map(l => keyIn(l, name)).find(v => v !== undefined);
    return value !== undefined ? [[name, value] as const] : [];
  });
  const picked = layers.map(l => keyIn(l, PROVIDER_ENV)).find(v => v !== undefined);
  return {
    ...env,
    ...(picked !== undefined ? { [PROVIDER_ENV]: picked } : {}),
    ...Object.fromEntries(keys),
    ...(flags.provider !== undefined ? { [PROVIDER_ENV]: flags.provider } : {}),
  };
}
