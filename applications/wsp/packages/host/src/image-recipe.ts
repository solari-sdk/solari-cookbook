// SPDX-License-Identifier: AGPL-3.0-only
// The recipe a build is composed from, in one place. wsp init composes one out
// of the screens' answers and seals it as the image; a copy at another place
// composes one out of the record alone, with every sign-in set to skip, since
// the sign-ins that copy needs are already in the vault the build lands on it.
// Both roads read the same three lines here, so a copy is planned the way the
// image itself was and nothing can drift between them.
import type { Manifest, ManifestEntry, Platform } from "@wsp/collect";
import { catalogIdOfRow } from "@wsp/catalog";
import type { BrewTable } from "@wsp/engine";
import { BREW_ID_PREFIX, customRows, type Recipe, type SealedImage, type SealedPin } from "@wsp/protocol";
import type { GoldenImport, GoldenRecipe, Machine } from "@wsp/runtime";
import { importFor, refusedIsDir, type ImportOptions } from "./init-import.js";
import { answeredRows, defaultAnswers, goldenRecipeFor, lockRefused, manifestFor, tickLoginTools, withoutAgentTools } from "./init-recipe.js";
import { withoutPins } from "./recipe-file.js";

/** What a build is planned against beyond the rows themselves: this computer, its Homebrew table for the rows a
 * formula installs, and the Keychain values already read for it. A copy's build reads no Keychain, so its values
 * are empty and the pack finds none to carry. */
export interface BuildContext {
  home: string;
  platform: Platform;
  brew: BrewTable;
  secrets: ReadonlyMap<string, string>;
  /** Where the values the copied MCP servers read by name are kept. */
  vault?: ImportOptions["vault"];
}

/** What the ticked rows come to on the builder: the files plan, the installs and the MCP plan. `picked` is the rows
 * this import carries, which is every ticked row on a full build and a subset of them on a delta; `rows` is every
 * row with its tick and its answer, since the MCP stage reads the unticked ones too. */
export function planImport(picked: readonly ManifestEntry[], o: BuildContext & { rows: readonly ManifestEntry[]; small: Recipe } & Pick<ImportOptions, "keepFile" | "onResult" | "onContext" | "path" | "prefix">): GoldenImport {
  return importFor(picked, {
    home: o.home,
    ...(o.path !== undefined ? { path: o.path } : {}),
    ...(o.prefix !== undefined ? { prefix: o.prefix } : {}),
    secrets: o.secrets,
    ...(o.vault !== undefined ? { vault: o.vault } : {}),
    platform: o.platform,
    rows: o.rows,
    brew: o.brew,
    custom: customRows(o.small),
    ...(o.keepFile !== undefined ? { keepFile: o.keepFile } : {}),
    ...(o.onResult !== undefined ? { onResult: o.onResult } : {}),
    ...(o.onContext !== undefined ? { onContext: o.onContext } : {}),
  });
}

/** The whole recipe a build runs from: what installs and travels, the envs each ticked agent asks for, and the
 * small recipe kept on it as what the build was planned from, which is what a copy at another place is built from
 * later. The small recipe goes on the record without the pins an earlier seal wrote on it: the record keeps what
 * this seal read beside it. */
export function planGoldenRecipe(
  o: BuildContext & { rows: readonly ManifestEntry[]; small: Recipe; deployDaemon?: (machine: Machine) => Promise<void | string> } & Pick<ImportOptions, "onResult" | "onContext">,
): { bring: ManifestEntry[]; import: GoldenImport; recipe: GoldenRecipe } {
  const bring = o.rows.filter(e => e.bring);
  const imp = planImport(bring, o);
  return {
    bring,
    import: imp,
    recipe: goldenRecipeFor(bring, { import: imp, source: withoutPins(o.small), ...(o.deployDaemon !== undefined ? { deployDaemon: o.deployDaemon } : {}) }),
  };
}

/** Whether this computer's rows need Homebrew read at all: a row of its own is here. The one reading, so the Tools
 * screen, a copy's build and a computer's provisioning ask it the same way. */
export const wantsBrew = (manifest: Manifest): boolean => manifest.entries.some(e => e.id.startsWith(BREW_ID_PREFIX));

/** The Homebrew table a plan off this computer runs against: read only where a brew row of its own is here, and an
 * empty one where brew will not answer, since a formula's size decides no tick on a plan already settled. The one
 * road, so a copy's build and a computer's provisioning cannot read this Mac two ways. */
export async function brewTableFor(manifest: Manifest, brew: (() => Promise<BrewTable>) | undefined): Promise<BrewTable> {
  return (wantsBrew(manifest) ? await brew?.().catch(() => undefined) : undefined) ?? new Map();
}

/** What a copy's build reads off this computer: the collector and the Homebrew table where there is one. The same
 * readers wsp init takes, minus the ones that only a person's screens use. */
export interface CopyReaders extends Pick<BuildContext, "home" | "platform" | "vault"> {
  collect(): Promise<Manifest>;
  brew?: () => Promise<BrewTable>;
  deployDaemon?: (machine: Machine) => Promise<void | string>;
}

/** The rows a copy is planned from: this computer as it is now with the record's own recipe written over it, the
 * record's pins on the rows they name, and every sign-in row set to skip and unticked. The place gets the person's
 * files, tools and agents from this computer and their sign-ins from the vault, so no sign-in runs there and no
 * Keychain is read here.
 *
 * The tool each answered sign-in needs is ticked before the answers go, the way wsp init ticks it: the small recipe
 * records the answer and not the tick it caused, so a copy planned off the answers as written would land a login on
 * a machine with nothing to read it. */
export function copyRows(manifest: Manifest, image: Pick<SealedImage, "pins"> & { recipe: Recipe }, o: { home: string; brew: BrewTable }): ManifestEntry[] {
  const here = lockRefused({ ...manifest, entries: withoutAgentTools(manifest.entries) }, refusedIsDir(o.home));
  const applied = withRecordPins(manifestFor({ manifest: here }, image.recipe), image.pins ?? []);
  const { ticks, choices } = defaultAnswers(applied, o.brew);
  tickLoginTools(applied, choices, ticks, o.brew);
  for (const e of applied.entries) {
    if (e.rung !== "logins") continue;
    choices.set(e.id, "skip");
    ticks.delete(e.id);
  }
  return answeredRows(applied, ticks, choices);
}

/** The record's pins on the rows they name, by the id a row is known by on every computer: the catalog id where the
 * catalog carries the tool, so the pin lands whether this computer has the tool by its own manager or the catalog's
 * bare row installs it, else the row's own id. A row whose road fixes a version takes the pin's as its own, in place
 * of whatever this computer runs today, so the copy installs what the seal read; a row marked latest carries the pin
 * for the record's sake and no version, since its road installs the current one wherever it runs. */
export function withRecordPins(manifest: Manifest, pins: readonly SealedPin[]): Manifest {
  const byId = new Map(pins.map(p => [p.id, p]));
  return {
    ...manifest,
    entries: manifest.entries.map(e => {
      const p = byId.get(catalogIdOfRow(e) ?? e.id);
      if (p === undefined) return e;
      const { id: _id, road: _road, ...pin } = p;
      const { version: _own, ...rest } = e;
      return { ...rest, pin, ...(pin.latest === true ? {} : { version: pin.tag }) };
    }),
  };
}

/** The recipe a copy at another place is built from, composed off the record alone. The record carries the small
 * recipe it was sealed from; this computer is read again for what those rows are here, since the files a copy
 * carries are the person's own and live nowhere else. A record with no small recipe has nothing to build from and
 * is refused by the runtime before this is asked for. */
export async function copyGoldenRecipe(image: SealedImage, o: CopyReaders): Promise<GoldenRecipe> {
  if (image.recipe === undefined) throw new Error(`${image.name} v${image.version} was sealed without the recipe it was built from, so no other place can build it`);
  const manifest = await o.collect();
  const brew = await brewTableFor(manifest, o.brew);
  const rows = copyRows(manifest, { ...image, recipe: image.recipe }, { home: o.home, brew });
  return planGoldenRecipe({
    rows,
    small: image.recipe,
    home: o.home,
    platform: o.platform,
    brew,
    // Nothing of the Keychain travels to a copy: what a sign-in left on the builder is in the vault already, and
    // reading the Keychain again would raise macOS's consent dialog for a build nobody is sitting at.
    secrets: new Map(),
    ...(o.vault !== undefined ? { vault: o.vault } : {}),
    ...(o.deployDaemon !== undefined ? { deployDaemon: o.deployDaemon } : {}),
  }).recipe;
}
