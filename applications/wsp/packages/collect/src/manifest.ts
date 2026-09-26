// SPDX-License-Identifier: AGPL-3.0-only
// The manifest is one row per thing the collector found on the laptop that
// could be brought to a golden. wsp init reads it, the person ticks rows, and
// the same shape with bring and choice filled in is saved as the recipe file,
// so one schema covers both a fresh collection and a saved recipe.
import { z } from "zod";
import { issuesLine, LoginChoice, ToolPin } from "@wsp/protocol";

export const RUNGS = ["identity", "shell", "toolchains", "tools", "agents", "logins"] as const;
export const Rung = z.enum(RUNGS);
export type Rung = z.infer<typeof Rung>;

export { LOGIN_CHOICES, LoginChoice } from "@wsp/protocol";

export const Default = z.enum(["bring", "skip"]);
export type Default = z.infer<typeof Default>;

/** Whether a tools row can be installed on the Linux machine; unknown when nothing on the laptop can tell. */
export const LINUX = ["yes", "no", "unknown"] as const;
export const Linux = z.enum(LINUX);
export type Linux = z.infer<typeof Linux>;

const Fields = z.object({
  rung: Rung,
  /** `<rung>/<name>`; the last segment looks up install and sign-in commands. */
  id: z.string().min(1),
  label: z.string(),
  /** Source paths on the laptop, `~`-relative; empty for a row that is a list item (a formula, an extension). */
  paths: z.array(z.string()),
  /** `~`-relative subtrees under `paths` that stay on the laptop; the pack copies paths minus excludes. */
  excludes: z.array(z.string()).optional(),
  /** `~`-relative entries of `paths` the tool rewrites while it runs (project state, plugin timestamps); they travel but never decide the recipe hash. */
  volatile: z.array(z.string()).optional(),
  bytes: z.number().int().nonnegative(),
  default: Default,
  /** Why the default is skip. With a reason the row renders locked off and cannot be ticked. */
  reason: z.string().optional(),
  /** Heading the row sits under inside its rung; the rung screen ticks a group as a unit. */
  group: z.string().optional(),
  /** Always brought, shown locked on. */
  required: z.boolean().optional(),
  /** The person's tick, written into the recipe file; absent on a fresh collection. */
  bring: z.boolean().optional(),
  /** The person's answer on a logins row; absent on a fresh collection. */
  choice: LoginChoice.optional(),
  /** Only on a tools row; the TUI greys out a "no". */
  linux: Linux.optional(),
  /** Only on a tools row: the version the laptop runs, which the machine installs by pin. */
  version: z.string().min(1).optional(),
  /** Only on a row a copy is planned from: the version the record pinned, which the road installs at and checks where a sum was recorded. */
  pin: ToolPin.optional(),
  /** Credential-shaped: travels only when the person answers copy on this row, never on a bare tick. */
  consent: z.boolean().optional(),
  /** One line for the detail pane: what found the row and what the flags mean. */
  detail: z.string().optional(),
  /** Exported variable names cut from the carried copy of this file, for the person to set on the machine. Names only, never values. */
  secrets: z.array(z.string()).optional(),
  /** Only on a shell row: the name of the login shell this computer runs, when /etc/shells lists it; it decides which ticked shell the machine logs into. */
  login: z.string().min(1).optional(),
  /** Only on a shell row: the family the person's terminal draws with, read from its config; the app's terminal pane defaults to it. */
  font: z.string().min(1).optional(),
  /** Only on a zsh or bash rc row: the files it reads on a bare source line, `~`-relative under home and absolute outside it; the pack wraps each line whose file it does not carry so the machine skips it without an error. */
  sources: z.array(z.string().min(1)).optional(),
});

export const ManifestEntry = Fields.superRefine((e, ctx) => {
  if (!e.id.startsWith(`${e.rung}/`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: `id must start with ${e.rung}/` });
  }
  if (e.choice !== undefined && e.rung !== "logins" && e.consent !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["choice"], message: "only a logins row or a consent row carries a choice" });
  }
  if (e.linux !== undefined && e.rung !== "tools") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linux"], message: "only a tools row carries a linux marker" });
  }
  if (e.version !== undefined && e.rung !== "tools") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["version"], message: "only a tools row carries a version" });
  }
  if (e.login !== undefined && e.rung !== "shell") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["login"], message: "only a shell row carries a login shell" });
  }
  if (e.font !== undefined && e.rung !== "shell") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["font"], message: "only a shell row carries a terminal font" });
  }
  if (e.sources !== undefined && e.rung !== "shell") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sources"], message: "only a shell row carries sourced files" });
  }
  if (e.required === true && e.default === "skip") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["required"], message: "a required row cannot default to skip" });
  }
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;

export const Manifest = z.object({ entries: z.array(ManifestEntry) }).superRefine((m, ctx) => {
  const seen = new Set<string>();
  m.entries.forEach((e, i) => {
    if (seen.has(e.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "id"], message: `duplicate id ${e.id}` });
    }
    seen.add(e.id);
  });
});
export type Manifest = z.infer<typeof Manifest>;

/** Parses unknown data into a manifest; the error names the failing row and field (entries.3.rung). */
export function parseManifest(data: unknown): Manifest {
  const r = Manifest.safeParse(data);
  if (r.success) return r.data;
  throw new Error(`invalid manifest: ${issuesLine(r.error.issues)}`);
}
