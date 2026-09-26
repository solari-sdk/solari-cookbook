// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { INSTALLER_MOVED_LINE, LOGIN_CHOICES, type LoginChoice, type RecipeDigest } from "@wsp/protocol";
import { SMALL_BYTES, SMALL_TOOLS, changeCounts, describeDiff, diffRecipes, isEmptyDiff, isSmallDelta, retiredBy, rowsToApply, type RecipeDiff } from "../src/golden-diff.js";
import type { RecipeEntry } from "../src/golden-import.js";

const row = (rung: string, id: string, over: Partial<RecipeEntry> = {}): RecipeEntry => ({ rung, id, label: id.slice(id.lastIndexOf("/") + 1), paths: [], bytes: 0, default: "bring", bring: true, ...over });
type DigestFile = RecipeDigest["files"][number];
/** A digested file; the two numbers stand in for the bytes that would be hashed. */
const file = (id: string, dest: string, size = 10, mtimeMs = 1000, path = `~/${dest}`): DigestFile => ({ id, dest, path, digest: `${size}:${mtimeMs}` });
/** The digest the seal writes: the ticked rows as ticks, the planned files as given; `rows` keeps the fixture rows for sizes. */
const snap = (entries: RecipeEntry[], files: DigestFile[] = []): RecipeDigest & { rows: RecipeEntry[] } => ({
  ticks: entries.filter(e => e.bring === true).map(e => ({ id: e.id, ...(e.choice !== undefined ? { choice: e.choice } : {}), ...(e.version !== undefined ? { version: e.version } : {}) })),
  files,
  rows: entries,
});
const bytesIn = (to: { rows: RecipeEntry[] }) => (id: string): number => to.rows.find(e => e.id === id)?.bytes ?? 0;
const EMPTY: RecipeDiff = { files: [], tools: [], agents: [], logins: [] };

describe("recipe diff", () => {
  const cases: { name: string; from: RecipeDigest; to: RecipeDigest; diff: RecipeDiff; apply: string[] }[] = [
    {
      name: "a file added",
      from: snap([row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc")]),
      to: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship")], [file("shell/zshrc", ".zshrc"), file("shell/starship", ".config/starship.toml")]),
      diff: { ...EMPTY, files: [{ id: "shell/starship", dest: ".config/starship.toml", change: "added" }] },
      apply: ["shell/starship"],
    },
    {
      name: "a file whose bytes changed",
      from: snap([row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc", 10)]),
      to: snap([row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc", 11)]),
      diff: { ...EMPTY, files: [{ id: "shell/zshrc", dest: ".zshrc", change: "changed" }] },
      apply: ["shell/zshrc"],
    },
    {
      name: "a volatile file whose bytes moved is no change: its tool rewrites it, or the machine renders it",
      from: snap([row("logins", "logins/gh", { choice: "copy" })], [{ ...file("logins/gh", ".config/gh/hosts.yml", 10, 1000), volatile: true }]),
      to: snap([row("logins", "logins/gh", { choice: "copy" })], [{ ...file("logins/gh", ".config/gh/hosts.yml", 10, 2000), volatile: true }]),
      diff: EMPTY,
      apply: [],
    },
    {
      name: "a file removed (its row unticked)",
      from: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship")], [file("shell/zshrc", ".zshrc"), file("shell/starship", ".config/starship.toml")]),
      to: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship", { bring: false })], [file("shell/zshrc", ".zshrc")]),
      diff: { ...EMPTY, files: [{ id: "shell/starship", dest: ".config/starship.toml", change: "removed" }] },
      apply: [],
    },
    {
      name: "a file whose dest moved is a removal and an addition",
      from: snap([row("agents", "agents/claude")], [file("agents/claude", ".claude", 10, 1000, "~/.claude")]),
      to: snap([row("agents", "agents/claude")], [file("agents/claude", ".claude-cfg", 10, 1000, "~/.claude")]),
      diff: { ...EMPTY, files: [{ id: "agents/claude", dest: ".claude-cfg", change: "added" }, { id: "agents/claude", dest: ".claude", change: "removed" }] },
      apply: ["agents/claude"],
    },
    {
      name: "a tool added",
      from: snap([]),
      to: snap([row("tools", "tools/brew/jq")]),
      diff: { ...EMPTY, tools: [{ id: "tools/brew/jq", label: "jq", change: "added" }] },
      apply: ["tools/brew/jq"],
    },
    {
      name: "a tool's pin changed",
      from: snap([row("tools", "tools/npm/bun", { version: "1.4.0" })]),
      to: snap([row("tools", "tools/npm/bun", { version: "1.5.0" })]),
      diff: { ...EMPTY, tools: [{ id: "tools/npm/bun", label: "bun", change: "changed", from: "1.4.0", to: "1.5.0" }] },
      apply: ["tools/npm/bun"],
    },
    {
      name: "a tool removed",
      from: snap([row("tools", "tools/brew/jq"), row("tools", "tools/npm/bun", { version: "1.4.0" })]),
      to: snap([row("tools", "tools/brew/jq")]),
      diff: { ...EMPTY, tools: [{ id: "tools/npm/bun", label: "bun", change: "removed", from: "1.4.0" }] },
      apply: [],
    },
    {
      name: "an agent added",
      from: snap([row("agents", "agents/claude")]),
      to: snap([row("agents", "agents/claude"), row("agents", "agents/codex")]),
      diff: { ...EMPTY, agents: [{ id: "agents/codex", label: "codex", change: "added" }] },
      apply: ["agents/codex"],
    },
    {
      name: "an agent removed",
      from: snap([row("agents", "agents/claude"), row("agents", "agents/codex")]),
      to: snap([row("agents", "agents/claude")]),
      diff: { ...EMPTY, agents: [{ id: "agents/codex", label: "codex", change: "removed" }] },
      apply: [],
    },
    {
      name: "a login now copied",
      from: snap([row("logins", "logins/gh", { choice: "machine" })]),
      to: snap([row("logins", "logins/gh", { choice: "copy" })], [file("logins/gh", ".config/gh/hosts.yml")]),
      diff: { ...EMPTY, files: [{ id: "logins/gh", dest: ".config/gh/hosts.yml", change: "added" }], logins: [{ id: "logins/gh", label: "gh", from: "machine", to: "copy" }] },
      apply: ["logins/gh"],
    },
    {
      name: "a login no longer copied takes its files off",
      from: snap([row("logins", "logins/gh", { choice: "copy" })], [file("logins/gh", ".config/gh/hosts.yml"), { id: "logins/gh", dest: ".config/gh/hosts.yml", path: "Keychain: gh:github.com", digest: "k", volatile: true }]),
      to: snap([row("logins", "logins/gh", { choice: "machine" })]),
      // The file and the Keychain secret land on one guest path, so one removal takes both off.
      diff: { ...EMPTY, files: [{ id: "logins/gh", dest: ".config/gh/hosts.yml", change: "removed" }], logins: [{ id: "logins/gh", label: "gh", from: "copy", to: "machine" }] },
      apply: [],
    },
    {
      name: "a login row unticked",
      from: snap([row("logins", "logins/codex", { choice: "copy" })]),
      to: snap([row("logins", "logins/codex", { bring: false, choice: "copy" })]),
      diff: { ...EMPTY, logins: [{ id: "logins/codex", label: "codex", from: "copy" }] },
      apply: [],
    },
    {
      name: "a ticked file gone from this computer is kept on the golden with a note, never removed",
      from: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship")], [file("shell/zshrc", ".zshrc"), file("shell/starship", ".config/starship.toml")]),
      to: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship")], [file("shell/zshrc", ".zshrc")]),
      diff: { ...EMPTY, files: [{ id: "shell/starship", dest: ".config/starship.toml", change: "missing" }] },
      apply: [],
    },
    {
      name: "the same recipe is no change, whatever the row order or the hash",
      from: snap([row("shell", "shell/zshrc"), row("tools", "tools/brew/jq")], [file("shell/zshrc", ".zshrc")]),
      to: snap([row("tools", "tools/brew/jq"), row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc")]),
      diff: EMPTY,
      apply: [],
    },
  ];

  it.each(cases)("$name", ({ from, to, diff, apply }) => {
    const got = diffRecipes(from, to);
    expect(got).toEqual(diff);
    expect([...rowsToApply(got)].sort()).toEqual(apply.sort());
    expect(isEmptyDiff(got)).toBe(diff === EMPTY);
    const dropped = diff.files.filter(f => f.change === "removed").map(f => f.id).concat(diff.tools.filter(t => t.change === "removed").map(t => t.id), diff.agents.filter(a => a.change === "removed").map(a => a.id));
    // A row this delta ships again is not retired, whatever else the diff says about it: a dest that moved is a
    // removal and an addition of one id, and the id stays in the recipe.
    expect(retiredBy(got).map(r => r.id)).toEqual(dropped.filter(id => !rowsToApply(got).has(id)));
  });

  it("a missing file is described as kept, and a login flipped to sign in says it will not be in the golden", () => {
    const from = snap([row("shell", "shell/zshrc"), row("logins", "logins/gh", { choice: "copy" })], [file("shell/zshrc", ".zshrc")]);
    const to = snap([row("shell", "shell/zshrc"), row("logins", "logins/gh", { choice: "machine" })], []);
    expect(describeDiff(diffRecipes(from, to))).toEqual([
      "kept on the golden, no longer on this computer: ~/.zshrc",
      "gh: a sign-in during the build is not done by an update, so it would not be in the golden; pick the rebuild for it",
    ]);
    expect(isSmallDelta(diffRecipes(from, to), bytesIn(to))).toBe(false);
  });

  it("an unticked row on either side is not a tool, agent or login of that side", () => {
    const from = snap([row("tools", "tools/brew/jq", { bring: false }), row("agents", "agents/codex", { bring: false })]);
    const to = snap([row("tools", "tools/brew/jq"), row("agents", "agents/codex")]);
    expect(diffRecipes(from, to)).toEqual({ ...EMPTY, tools: [{ id: "tools/brew/jq", label: "jq", change: "added" }], agents: [{ id: "agents/codex", label: "codex", change: "added" }] });
  });
});

describe("a tool's road, pin and install lines", () => {
  type Tick = RecipeDigest["ticks"][number];
  const ID = "tools/catalog/gh";
  const gh = (over: Partial<Tick>): RecipeDigest => ({ ticks: [{ id: ID, ...over }], files: [] });
  const pin = (tag: string, sha = "b") => ({ tag, sha256: sha.repeat(64) });
  const release = (over: Partial<Tick> = {}): RecipeDigest => gh({ road: "release", installer: "i".repeat(64), ...over });
  const changed = (why: string): RecipeDiff => ({ ...EMPTY, tools: [{ id: ID, label: "gh", change: "changed", why }] });

  const cases: { name: string; from: RecipeDigest; to: RecipeDigest; diff: RecipeDiff }[] = [
    // A pin is what a build read back, never what the recipe asks: the sealed digest carries one and the plan none, and nothing moves.
    { name: "a pin on the sealed side and none on the plan is no change", from: release({ pin: pin("v2.86.0") }), to: release(), diff: EMPTY },
    { name: "the same pin folds away", from: release({ pin: pin("v2.86.0") }), to: release({ pin: pin("v2.86.0") }), diff: EMPTY },
    { name: "a pin that differs alone, tag or sum, is no change", from: release({ pin: pin("v2.86.0", "b") }), to: release({ pin: pin("v2.85.0", "c") }), diff: EMPTY },
    { name: "a latest mark on the sealed side is no change", from: release({ pin: { ...pin("v2.86.0"), latest: true } }), to: release(), diff: EMPTY },
    { name: "a road that moved is a changed row, in the roads' own words", from: gh({ road: "brew", installer: "a" }), to: gh({ road: "script", installer: "b" }), diff: changed("now by its own installer, was with Homebrew") },
    { name: "install lines that moved under the same road and pin are a changed row", from: release({ installer: "a" }), to: release({ installer: "b" }), diff: changed(INSTALLER_MOVED_LINE) },
    { name: "a version that moved is said by version, whatever moved with it", from: release({ version: "v2.86.0" }), to: release({ version: "v2.87.0", installer: "j" }), diff: { ...EMPTY, tools: [{ id: ID, label: "gh", change: "changed", from: "v2.86.0", to: "v2.87.0" }] } },
    { name: "a tick sealed before the digest carried a road moves nothing on its account", from: gh({}), to: release({ pin: pin("v2.86.0") }), diff: EMPTY },
    { name: "the same road and lines with no pin on either side is no change", from: release(), to: release(), diff: EMPTY },
  ];

  it.each(cases)("$name", ({ from, to, diff }) => {
    const got = diffRecipes(from, to);
    expect(got).toEqual(diff);
    expect([...rowsToApply(got)]).toEqual(diff === EMPTY ? [] : [ID]);
    expect(isEmptyDiff(got)).toBe(diff === EMPTY);
  });

  it("the words name the row and why, and the build line counts it as a tool updated", () => {
    const d = diffRecipes(release({ installer: "a" }), release({ installer: "b" }));
    expect(describeDiff(d)).toEqual([`update 1 tool: gh (${INSTALLER_MOVED_LINE})`]);
    expect(changeCounts(d).filter(c => c.count > 0)).toEqual([{ count: 1, noun: "tool", word: "updated" }]);
    expect(isSmallDelta(d, () => 0)).toBe(true);
    expect(describeDiff(diffRecipes(gh({ road: "brew", installer: "a" }), gh({ road: "script", installer: "b" })))).toEqual(["update 1 tool: gh (now by its own installer, was with Homebrew)"]);
  });
});

describe("rows the recipe stopped asking for", () => {
  const retired = (entries: RecipeEntry[], files: DigestFile[] = [], previous: { id: string; name: string }[] = []) => retiredBy(diffRecipes(snap(entries, files), snap([])), previous);

  it("a file, a tool and an agent are recorded by id with the person's name for them, and nothing is uninstalled", () => {
    expect(retired([row("shell", "shell/zshrc"), row("tools", "tools/brew/yq"), row("agents", "agents/codex")], [file("shell/zshrc", ".zshrc")])).toEqual([
      { id: "shell/zshrc", name: "~/.zshrc" },
      { id: "tools/brew/yq", name: "yq" },
      { id: "agents/codex", name: "codex" },
    ]);
  });

  it("what the version being updated retired rides along, and a row ticked again leaves the list", () => {
    const was = [{ id: "tools/brew/yq", name: "yq" }, { id: "tools/npm/bun", name: "bun" }];
    const from = snap([row("tools", "tools/brew/jq")]);
    const to = snap([row("tools", "tools/brew/jq"), row("tools", "tools/npm/bun")]);
    expect(retiredBy(diffRecipes(from, to), was)).toEqual([{ id: "tools/brew/yq", name: "yq" }]);
  });

  it("a row retired twice is recorded once", () => {
    expect(retired([row("tools", "tools/brew/yq")], [], [{ id: "tools/brew/yq", name: "yq" }])).toEqual([{ id: "tools/brew/yq", name: "yq" }]);
  });

  it("nothing changed retires nothing", () => {
    const same = snap([row("tools", "tools/brew/jq")]);
    expect(retiredBy(diffRecipes(same, same))).toEqual([]);
  });
});

describe("describing and sizing the delta", () => {
  it("one line per kind of change, in plain words", () => {
    const from = snap([row("shell", "shell/zshrc"), row("tools", "tools/npm/bun", { version: "1.4.0" }), row("tools", "tools/brew/yq"), row("agents", "agents/codex"), row("logins", "logins/gh", { choice: "copy" }), row("logins", "logins/codex", { choice: "machine" })], [
      file("shell/zshrc", ".zshrc"),
      file("logins/gh", ".config/gh/hosts.yml"),
    ]);
    const to = snap(
      [row("shell", "shell/zshrc"), row("shell", "shell/starship"), row("tools", "tools/npm/bun", { version: "1.5.0" }), row("tools", "tools/brew/jq"), row("agents", "agents/aider"), row("logins", "logins/gh", { choice: "machine" }), row("logins", "logins/codex", { choice: "copy" })],
      [file("shell/zshrc", ".zshrc", 99), file("shell/starship", ".config/starship.toml"), file("logins/codex", ".codex/auth.json")],
    );
    expect(describeDiff(diffRecipes(from, to))).toEqual([
      "add 2 files: ~/.config/starship.toml, ~/.codex/auth.json",
      "add 1 tool: jq",
      "add 1 agent: aider",
      "update 1 file: ~/.zshrc",
      "update 1 tool: bun (1.4.0 to 1.5.0)",
      "retire 1 file: ~/.config/gh/hosts.yml, left on the image",
      "retire 1 tool: yq, left on the image",
      "retire 1 agent: codex, left on the image",
      "gh: a sign-in during the build is not done by an update, so it would not be in the golden; pick the rebuild for it",
      "copy the codex",
    ]);
  });

  it("quotes a tool label that carries the comma these lines join their names with, added and updated alike", () => {
    const pair = "tools/custom/swift-format, swiftlint";
    const added = describeDiff(diffRecipes(snap([]), snap([row("tools", pair), row("tools", "tools/brew/just")])));
    expect(added).toEqual([`add 2 tools: "swift-format, swiftlint", just`]);
    // With the quoted label read as one word, the count and the entries the line splits into agree.
    expect(added[0]!.replace(/"[^"]*"/g, "row").split(": ")[1]!.split(", ")).toHaveLength(2);
    const updated = describeDiff(diffRecipes(snap([row("tools", pair, { version: "1.0" })]), snap([row("tools", pair, { version: "1.1" })])));
    expect(updated).toEqual([`update 1 tool: "swift-format, swiftlint" (1.0 to 1.1)`]);
  });

  it("small: no agent added, at most SMALL_TOOLS tool installs, at most SMALL_BYTES to upload", () => {
    const base = snap([]);
    const tools = (n: number) => Array.from({ length: n }, (_, i) => row("tools", `tools/brew/t${i}`));
    expect(isSmallDelta(diffRecipes(base, snap(tools(SMALL_TOOLS))), bytesIn(snap(tools(SMALL_TOOLS))))).toBe(true);
    expect(isSmallDelta(diffRecipes(base, snap(tools(SMALL_TOOLS + 1))), bytesIn(snap(tools(SMALL_TOOLS + 1))))).toBe(false);
    const agent = snap([row("agents", "agents/codex")]);
    expect(isSmallDelta(diffRecipes(base, agent), bytesIn(agent))).toBe(false);
    const gone = snap([row("agents", "agents/codex")]);
    expect(isSmallDelta(diffRecipes(gone, base), bytesIn(base))).toBe(true);
    const big = snap([row("shell", "shell/nvim", { bytes: SMALL_BYTES + 1 })], [file("shell/nvim", ".config/nvim")]);
    expect(isSmallDelta(diffRecipes(base, big), bytesIn(big))).toBe(false);
    const fits = snap([row("shell", "shell/nvim", { bytes: SMALL_BYTES })], [file("shell/nvim", ".config/nvim")]);
    expect(isSmallDelta(diffRecipes(base, fits), bytesIn(fits))).toBe(true);
    // A row already on the golden and unchanged does not count against the upload.
    const same = snap([row("shell", "shell/nvim", { bytes: SMALL_BYTES + 1 }), row("shell", "shell/zshrc", { bytes: 5 })], [file("shell/nvim", ".config/nvim"), file("shell/zshrc", ".zshrc")]);
    const before = snap([row("shell", "shell/nvim", { bytes: SMALL_BYTES + 1 })], [file("shell/nvim", ".config/nvim")]);
    expect(isSmallDelta(diffRecipes(before, same), bytesIn(same))).toBe(true);
  });
});

describe("what the build line counts", () => {
  it("added and updated rows by their noun, everything the update retires as one, and no login taking the rebuild road", () => {
    const from = snap([row("tools", "tools/brew/yq"), row("logins", "logins/gh", { choice: "copy" })], [file("logins/gh", ".config/gh/hosts.yml")]);
    const to = snap([row("tools", "tools/brew/jq"), row("tools", "tools/npm/bun"), row("logins", "logins/gh", { choice: "machine" })]);
    expect(changeCounts(diffRecipes(from, to)).filter(c => c.count > 0)).toEqual([
      { count: 2, noun: "tool", word: "added" },
      { count: 2, noun: "row", word: "retired" },
    ]);
  });

  it("a recipe that only adds two tools counts exactly those", () => {
    const from = snap([]);
    const to = snap([row("tools", "tools/brew/jq"), row("tools", "tools/npm/bun")]);
    expect(changeCounts(diffRecipes(from, to)).filter(c => c.count > 0)).toEqual([{ count: 2, noun: "tool", word: "added" }]);
  });
});

describe("a login answered with an API key or a token", () => {
  const keyed = (from: LoginChoice, to: LoginChoice) => diffRecipes(snap([row("logins", "logins/claude", { choice: from })]), snap([row("logins", "logins/claude", { choice: to })]));

  it("is named for what it is, never as a login taken off the machine", () => {
    expect(describeDiff(keyed("copy", "key"))).toEqual(["claude: the API key is held on this computer and set on every turn, so nothing of it lands on the machine"]);
    expect(describeDiff(keyed("copy", "token"))).toEqual(["claude: the token is held on this computer and set on every turn, so nothing of it lands on the machine"]);
  });

  it("takes no rebuild: the vault hands both to a turn at launch, so a machine already running carries them", () => {
    expect(isSmallDelta(keyed("copy", "key"), () => 0)).toBe(true);
    expect(isSmallDelta(keyed("copy", "token"), () => 0)).toBe(true);
    expect(isSmallDelta(keyed("copy", "machine"), () => 0)).toBe(false);
    // The answers an update can carry stay small.
    expect(isSmallDelta(keyed("machine", "copy"), () => 0)).toBe(true);
    expect(isSmallDelta(keyed("copy", "skip"), () => 0)).toBe(true);
  });

  it("brings nothing and retires nothing of its own: the key is not a row with bytes", () => {
    expect([...rowsToApply(keyed("machine", "key"))]).toEqual([]);
    expect(retiredBy(keyed("machine", "key"))).toEqual([]);
  });

  it("a row the new recipe carries no answer for is retired, not taken off the machine", () => {
    const gone = diffRecipes(snap([row("logins", "logins/claude", { choice: "copy" })]), snap([row("logins", "logins/claude")]));
    expect(describeDiff(gone)).toEqual(["retire the claude, left signed in on the image"]);
  });

  it("every answer the sign-ins screen can give has its own words and its own road: a fifth one does not compile", () => {
    // LOGIN_ANSWERS is keyed by LoginChoice, so an answer added to the union without an entry fails the build.
    // This proves the entries that exist say something of their own rather than all falling to the same line.
    const dropped = describeDiff(diffRecipes(snap([row("logins", "logins/claude", { choice: "copy" })]), snap([row("logins", "logins/claude")])));
    for (const choice of LOGIN_CHOICES) {
      const line = describeDiff(keyed(choice === "copy" ? "machine" : "copy", choice));
      expect(line).toHaveLength(1);
      if (choice !== "skip") expect(line).not.toEqual(dropped);
    }
    expect(new Set(LOGIN_CHOICES.map(c => describeDiff(keyed(c === "copy" ? "machine" : "copy", c))[0])).size).toBe(LOGIN_CHOICES.length);
  });
});
