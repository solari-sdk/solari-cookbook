// SPDX-License-Identifier: AGPL-3.0-only
// wsp init when a golden already exists: the saved recipe against the one the
// golden was built from, an offer to build the next version on top of it from
// the delta with the full rebuild one keypress away, and the update itself
// through the runtime. An update only ever adds: a row the recipe dropped is
// retired on the new version, never taken off the image.
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
import { SnapshotFailedError, changeCounts, describeDiff, diffRecipes, isEmptyDiff, isSmallDelta, retiredBy, rowsToApply, type GoldenDelta, type GoldenImport, type RecipeDiff } from "@wsp/engine";
import { goldenBuildLine, upgradeSealFailedGoneLine, upgradeSealFailedStaysLine, upgradeSealFailedUnreadLine, type GoldenLogin, type GoldenRetired, type RecipeDigest, GOLDEN_STAGE_WORDS } from "@wsp/protocol";
import { GRACE_MS, goldenHead, type GoldenBuilderView, type Runtime } from "@wsp/runtime";
import { cancel, isCancel, log, note, outro, select } from "@clack/prompts";
import { rebuildEstimate, type BuildTimes } from "./init-times.js";
import type { StageWords } from "./init.js";

const dim = (s: string): string => styleText("dim", s);

/** The update's stages in order: the machine it lands on, the delta through the import stages, the seal. */
export const UPGRADE_STEPS: readonly StageWords[] = [
  { stage: "creating", start: "Preparing the machine", end: "Machine ready", fail: "Preparing the machine failed" },
  { stage: "applying-setup", start: "Applying the changes", end: "Changes applied", fail: "Applying the changes failed" },
  { stage: "uploading-files", start: "Uploading your files", end: "Files uploaded", fail: "Uploading your files failed" },
  { stage: "installing-harness", start: "Installing agents", end: "Agents installed", fail: "Installing agents failed" },
  { stage: "installing-tools", start: "Installing tools", end: "Tools installed", fail: "Installing tools failed" },
  { stage: "installing-mcp", start: "Installing MCP servers", end: "MCP servers installed", fail: "Installing MCP servers failed" },
  { stage: "ready", start: GOLDEN_STAGE_WORDS.ready, end: "Ready", fail: "The machine never answered" },
  { stage: "snapshotting", start: GOLDEN_STAGE_WORDS.snapshotting, end: "Snapshot taken", fail: "Snapshot failed" },
  { stage: "promoting", start: GOLDEN_STAGE_WORDS.promoting, end: "Image saved", fail: "Saving the image failed" },
  { stage: "smoke-forking", start: GOLDEN_STAGE_WORDS["smoke-forking"], end: "Fork booted and checked", fail: "The fork failed its check" },
  { stage: "sealed", start: GOLDEN_STAGE_WORDS.sealed, end: "Sealed", fail: "Seal failed" },
];

/** Said once as the update runs: what stays and what is applied. */
export function upgradeSentence(from: number, to: number): string {
  return `Updating your image to v${to}: files, tools, agents and logins on it are kept and only the changes above are applied; workspaces on v${from} stay there until you upgrade them.`;
}

export interface UpgradeOffer {
  diff: RecipeDiff;
  small: boolean;
  /** Read at the moment of the offer, so the person sees the road the update would take. */
  onBuilder: boolean;
  version: number;
  /** What each machine the update boots costs while it runs. */
  rateUsdPerHour: number;
  /** The last build this computer measured, when there is one; the rebuild road is estimated from it. */
  lastBuild: BuildTimes | undefined;
}

/** The cost line: the fork road boots a fork and a smoke fork, the kept builder road a smoke fork beside the builder. */
export function describeCost(o: Pick<UpgradeOffer, "onBuilder" | "rateUsdPerHour">): string {
  const rate = `about $${o.rateUsdPerHour.toFixed(2)}/hr`;
  return o.onBuilder ? `a smoke fork boots beside it, ${rate} while it runs` : `a fork and a smoke fork boot, ${rate} each while they run`;
}

/** The builder an update would land on: this setup's, kept as the current version, still sealable, inside its
 * window, held by nobody else. */
export function keptBuilder(builders: readonly GoldenBuilderView[], version: number, name = "default"): GoldenBuilderView | undefined {
  return builders.find(b => b.name === name && b.sealable === true && b.sealed?.version === version && b.heldBy === undefined && b.foreignOwner === undefined && Date.now() - Date.parse(b.sealed.at) < GRACE_MS);
}

/** Before a rebuild boots: the kept builder holds one of the account's machine slots, so it goes first, said once.
 * Runs after the boot confirm, so a No leaves it as it was. */
export async function stopKeptBuilder(rt: Runtime, output: Writable): Promise<void> {
  const version = (await rt.golden.get())?.head;
  const kept = version === undefined ? undefined : keptBuilder(await rt.golden.builders(), version);
  if (kept === undefined) return;
  log.step(`Stopping the builder kept from image v${version} (${kept.id}) to free its machine slot.`, { output });
  await rt.golden.kill(kept.id);
}

/** Measured live: 38 to 44 s on the kept builder, 75 to 124 s on a fork (the fork boot and the smoke fork are the spread). */
const ON_BUILDER = "under a minute";
const ON_FORK = "about two minutes";

export function describeOffer(o: UpgradeOffer): string[] {
  const where = o.onBuilder ? `on the builder kept since the save, ${ON_BUILDER}` : `on a fork of your image, ${ON_FORK}`;
  return [
    goldenBuildLine(o.version, o.version + 1, changeCounts(o.diff)),
    ...describeDiff(o.diff),
    "",
    o.small ? `Small change: update ${where}; ${describeCost(o)}.` : `A big change: a rebuild from scratch is the safer road, ${rebuildEstimate(o.lastBuild)}.`,
    ...(o.small ? [] : [`An update would run ${where}; ${describeCost(o)}.`]),
  ];
}

/** What the updated version says about its logins: the previous version's outcomes as they were, since the update
 * keeps the golden's disk, with every login whose choice moved to copy rewritten as copied (it was re-imported from
 * this computer). A login moved to sign in is left as it was: that change takes the rebuild road. */
export function carryLogins(previous: readonly GoldenLogin[] | undefined, diff: RecipeDiff): GoldenLogin[] | undefined {
  const copied = diff.logins.filter(l => l.to === "copy" && l.from !== "copy");
  if (copied.length === 0) return previous === undefined ? undefined : [...previous];
  const out: GoldenLogin[] = (previous ?? []).map(l => (copied.some(c => c.label === l.name) ? { name: l.name, state: "copied" } : l));
  for (const c of copied) if (!out.some(l => l.name === c.label)) out.push({ name: c.label, state: "copied" });
  return out;
}

/** The delta the runtime applies: the rows the diff names, planned like a
 * first build but hashed as the whole recipe, the rows this run takes out of
 * the recipe, and what the next version's image will carry that its recipe
 * does not ask for: the run's own rows are what it says, the folded list is
 * what the version records. */
export function deltaFor(diff: RecipeDiff, full: GoldenImport, bring: readonly ManifestEntry[], importOf: (rows: readonly ManifestEntry[]) => GoldenImport, retired: readonly GoldenRetired[] = []): GoldenDelta {
  const rows = rowsToApply(diff);
  const part = importOf(bring.filter(e => rows.has(e.id)));
  return {
    import: { ...part, recipeHash: full.recipeHash, ...(full.recipe !== undefined ? { recipe: full.recipe } : {}) },
    retired: retiredBy(diff),
    retiredOnImage: retiredBy(diff, retired),
  };
}

export interface UpdateRoadOptions {
  rt: Runtime;
  /** The recipe the golden's head was built from. */
  current: RecipeDigest;
  /** The whole new recipe as an import, and the rows it came from. */
  imp: GoldenImport;
  bring: readonly ManifestEntry[];
  /** Every row this computer offered, ticked or not: the words and sizes the diff is described with. */
  rows: readonly ManifestEntry[];
  importOf: (rows: readonly ManifestEntry[]) => GoldenImport;
  lastBuild: BuildTimes | undefined;
  interactive: boolean;
  yes: boolean;
  /** Draws the update's stages as they arrive; returns once the runtime call settles. */
  stream: (words: readonly StageWords[], run: () => Promise<unknown>) => Promise<{ failure?: string }>;
  input: Readable;
  output: Writable;
}

/** 0: updated, or nothing to update. 1: cancelled or failed. "rebuild": the person wants the full build instead. */
export async function updateRoad(o: UpdateRoadOptions): Promise<0 | 1 | "rebuild"> {
  const out = { output: o.output };
  const manifest = await o.rt.golden.get();
  const version = manifest?.head ?? 0;
  if (o.imp.recipe === undefined) return "rebuild";
  const rowOf = (id: string): ManifestEntry | undefined => o.rows.find(e => e.id === id);
  const diff = diffRecipes(o.current, o.imp.recipe, id => rowOf(id)?.label ?? id.slice(id.lastIndexOf("/") + 1));
  if (isEmptyDiff(diff)) {
    log.success(`Image v${version} already matches this recipe. Nothing to update; run wsp to serve it.`, out);
    return 0;
  }
  const head = goldenHead(manifest);
  if (head?.base === undefined) {
    note(describeDiff(diff).join("\n"), `Changes since image v${version}`, out);
    log.step(`Image v${version} was sealed before the base tools existed and cannot take an update; the rebuild is the only road, ${rebuildEstimate(o.lastBuild)}.`, out);
    return "rebuild";
  }
  const kept = keptBuilder(await o.rt.golden.builders(), version);
  const rateUsdPerHour = o.rt.backend.pricing.rateUsdPerHour(head?.size ?? kept?.size ?? o.rt.backend.pricing.defaultSize);
  const offer: UpgradeOffer = { diff, small: isSmallDelta(diff, id => rowOf(id)?.bytes ?? 0), onBuilder: kept !== undefined, version, rateUsdPerHour, lastBuild: o.lastBuild };
  note(describeOffer(offer).join("\n"), `Changes since image v${version}`, out);

  let road: "update" | "rebuild";
  if (o.interactive) {
    const picked = await select<"update" | "rebuild">({
      message: "How do you want to apply them?",
      options: [
        { value: "update", label: `Update your image (${offer.onBuilder ? ON_BUILDER : ON_FORK}, about $${rateUsdPerHour.toFixed(2)}/hr while it runs)`, hint: `v${version + 1} from v${version} plus the changes` },
        { value: "rebuild", label: `Rebuild from scratch (${rebuildEstimate(o.lastBuild)})`, hint: "a fresh machine, every file and tool again" },
      ],
      initialValue: offer.small ? "update" : "rebuild",
      input: o.input,
      output: o.output,
    });
    if (isCancel(picked)) {
      cancel("Nothing was changed. The recipe is kept.", out);
      return 1;
    }
    road = picked;
  } else {
    road = offer.small ? "update" : "rebuild";
    log.step(`${road === "update" ? "Updating your image" : "Rebuilding from scratch"}. Taken as the default (${o.yes ? "--yes" : "no terminal"}).`, out);
  }
  if (road === "rebuild") return "rebuild";

  const delta = deltaFor(diff, o.imp, o.bring, o.importOf, head.retired ?? []);
  log.step(upgradeSentence(version, version + 1), out);
  const t0 = Date.now();
  let result: Awaited<ReturnType<Runtime["golden"]["upgrade"]>> | undefined;
  let error: unknown;
  const logins = carryLogins(head.logins, diff);
  const view = await o.stream(UPGRADE_STEPS, () => o.rt.golden.upgrade({ delta, ...(logins !== undefined ? { logins } : {}) }).then(r => (result = r), e => (error = e)));
  if (result === undefined) {
    if (view.failure === undefined) log.error(error instanceof Error ? error.message : String(error), out);
    // A snapshot the provider refused leaves the machine it ran on as it was; the words follow what the provider says of it.
    if (error instanceof SnapshotFailedError) {
      outro(
        error.builderState === "gone" ? upgradeSealFailedGoneLine(version) : error.builderState === "unread" ? upgradeSealFailedUnreadLine(version, error.machineId) : upgradeSealFailedStaysLine(version, error.machineId, rateUsdPerHour),
        out,
      );
      return 1;
    }
    // A failed delta on the kept builder kills it, so the retry forks; the person hears that before they retry.
    outro(
      offer.onBuilder
        ? `Image v${version} is unchanged and the builder kept since the save is gone. Run wsp init again to retry on a fork of your image (${ON_FORK}), or pick the rebuild.`
        : `Image v${version} is unchanged. Run wsp init again to retry, or pick the rebuild.`,
      out,
    );
    return 1;
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(0);
  const builder = keptBuilder(await o.rt.golden.builders(), result.version.version);
  const rate = o.rt.backend.pricing.rateUsdPerHour(builder?.size ?? o.rt.backend.pricing.defaultSize);
  log.success(
    [
      `Image v${result.version.version} sealed in ${seconds}s ${result.road === "builder" ? "on the builder kept since the save" : "from a fork of your image"}; new workspaces fork it.`,
      ...(result.builderKept
        ? [dim(`The builder stays up (about $${rate.toFixed(2)}/h, one of the account's machine slots) until wsp init updates on it again, a wsp sweep stops it ten minutes after the save, or the provider's six-hour idle kill fires. Run wsp to serve.`)]
        : [dim("Run wsp to serve.")]),
    ].join("\n"),
    out,
  );
  return 0;
}
