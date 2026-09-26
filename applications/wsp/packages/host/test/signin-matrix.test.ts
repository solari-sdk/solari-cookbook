// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in matrix: every login source the table names, against every tool
// the collector can emit a login row for. A cell says what the source alone
// looks like on a fake laptop, the row the collector makes of it, and what the
// Sign-ins screen starts it at, so every tool's default is a tested cell. A
// cell the product cannot produce is listed with its reason, never left out; a
// source added to the table without a cell fails the coverage test by name.
import { detectLogins, type LoginChoice } from "@wsp/collect";
import { describe, expect, it } from "vitest";
import { fakeHost, type FakeLaptop } from "../../collect/test/fake-host.js";
import { initialChoice } from "../src/init-recipe.js";
import { SIGN_INS, type LoginSource } from "../src/signin-table.js";
import { collectorLogins } from "./collector-logins.js";

type Source = LoginSource | "none";
const SOURCES: readonly Source[] = ["keychain", "rc-key", "file", "helper", "none"];

interface Row {
  paths: string[];
  default: "bring" | "skip";
  detail?: string;
  /** The sign-in column: what the row starts as on the Sign-ins screen, read off the collector's row by the wizard.
   * A row with nothing here to copy starts left to first use: its only road is a browser, and the build waits on nobody. */
  starts: LoginChoice;
}

interface Reachable {
  tool: string;
  source: Source;
  /** This source alone on the laptop, and the row the collector makes of it; no row when the source alone makes none. */
  laptop: FakeLaptop;
  row?: Row;
}

interface Unreachable {
  tool: string;
  source: Source;
  unreachable: string;
  /** The source on the laptop when it can be set up, to prove the collector makes no row of it. */
  laptop?: FakeLaptop;
}

type Cell = Reachable | Unreachable;

/** The values the fake laptops carry; none may reach a row. */
const FAKE_VALUES = ["sk-ant-x", "gho_x", "cf-x", "AIza-x", "aws-x", "sk-oai-x"];

const OWN_FILES = "keeps its login in its own files; the collector reads no Keychain item, rc key or helper for it";
/** The other sources of a tool that keeps its login in files alone. */
const filesOnly = (tool: string, ...except: Source[]): Unreachable[] =>
  (["keychain", "rc-key", "helper"] as const).filter(s => !except.includes(s)).map(source => ({ tool, source, unreachable: `${tool} ${OWN_FILES}` }));

const MATRIX: readonly Cell[] = [
  // gh: hosts.yml names the account; on macOS the token is a Keychain item that lands inside hosts.yml on the machine.
  { tool: "gh", source: "file", laptop: { files: { "~/.config/gh/hosts.yml": 200 } }, row: { paths: ["~/.config/gh/hosts.yml"], default: "skip", starts: "later" } },
  {
    tool: "gh",
    source: "keychain",
    laptop: { files: { "~/.config/gh/hosts.yml": 200 }, exec: { "security find-generic-password -s gh:github.com": "keychain: ...\n" } },
    row: { paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], default: "skip", starts: "later" },
  },
  { tool: "gh", source: "rc-key", unreachable: "gh's row is its hosts.yml; GH_TOKEN alone makes no row and travels only as a secret with the rc file", laptop: { files: { "~/.zshrc": "export GH_TOKEN=gho_x\n" } } },
  { tool: "gh", source: "helper", unreachable: "only Claude Code reads an apiKeyHelper" },
  { tool: "gh", source: "none", laptop: {} },

  {
    tool: "gcloud",
    source: "file",
    laptop: { files: { "~/.config/gcloud/credentials.db": 4000, "~/.config/gcloud/configurations/config_default": 50 } },
    row: { paths: ["~/.config/gcloud/credentials.db", "~/.config/gcloud/configurations"], default: "skip", starts: "later" },
  },
  ...filesOnly("gcloud"),
  { tool: "gcloud", source: "none", laptop: {} },

  {
    tool: "wrangler",
    source: "file",
    laptop: { files: { "~/Library/Preferences/.wrangler/config/default.toml": 300 } },
    row: { paths: ["~/Library/Preferences/.wrangler/config/default.toml"], default: "skip", starts: "later" },
  },
  {
    tool: "wrangler",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export CLOUDFLARE_API_TOKEN=cf-x\n" } },
  },
  ...filesOnly("wrangler", "rc-key"),
  {
    tool: "wrangler",
    source: "none",
    laptop: {},
  },

  { tool: "cloudflared", source: "file", laptop: { files: { "~/.cloudflared/cert.pem": 800 } }, row: { paths: ["~/.cloudflared/cert.pem"], default: "skip", starts: "later" } },
  ...filesOnly("cloudflared"),
  { tool: "cloudflared", source: "none", laptop: {} },

  {
    tool: "vercel",
    source: "file",
    laptop: { files: { "~/Library/Application Support/com.vercel.cli/auth.json": 100 } },
    row: { paths: ["~/Library/Application Support/com.vercel.cli/auth.json"], default: "skip", starts: "later" },
  },
  ...filesOnly("vercel"),
  { tool: "vercel", source: "none", laptop: {} },

  {
    tool: "aws",
    source: "file",
    laptop: { files: { "~/.aws/credentials": 120, "~/.aws/config": 300 } },
    row: { paths: ["~/.aws/credentials", "~/.aws/config"], default: "skip", starts: "later" },
  },
  {
    tool: "aws",
    source: "rc-key",
    unreachable: "the keys alone make no row; they travel as secrets with the rc file, and what sts prints for them was not measured",
    laptop: { files: { "~/.zshrc": "export AWS_ACCESS_KEY_ID=aws-x\nexport AWS_SECRET_ACCESS_KEY=aws-x\n" } },
  },
  ...filesOnly("aws", "rc-key"),
  { tool: "aws", source: "none", laptop: {} },

  // kubectl has no sign-in: the row starts as a copy.
  { tool: "kube", source: "file", laptop: { files: { "~/.kube/config": 6000 } }, row: { paths: ["~/.kube/config"], default: "bring", starts: "copy" } },
  ...filesOnly("kube"),
  { tool: "kube", source: "none", laptop: {} },

  // Codex's login lives on the computer that runs the workspaces, so its file is found here and offered nowhere.
  { tool: "codex", source: "file", laptop: { files: { "~/.codex/auth.json": 900 } }, row: { paths: [], default: "skip", detail: "it signs in once on the computer that runs your workspaces; nothing of it travels", starts: "later" } },
  { tool: "codex", source: "rc-key", unreachable: "the key alone makes no row; it travels as a secret with the rc file, and what codex login status prints for it was not measured", laptop: { files: { "~/.zshrc": "export OPENAI_API_KEY=sk-oai-x\n" } } },
  ...filesOnly("codex", "rc-key"),
  { tool: "codex", source: "none", laptop: {} },

  { tool: "gemini", source: "file", laptop: { files: { "~/.gemini/oauth_creds.json": 500 } }, row: { paths: ["~/.gemini/oauth_creds.json"], default: "skip", starts: "later" } },
  {
    tool: "gemini",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export GEMINI_API_KEY=AIza-x\n" } },
  },
  ...filesOnly("gemini", "rc-key"),
  { tool: "gemini", source: "none", laptop: {} },

  {
    tool: "opencode",
    source: "file",
    laptop: { files: { "~/.local/share/opencode/auth.json": 200 } },
    row: { paths: ["~/.local/share/opencode/auth.json"], default: "bring", starts: "copy" },
  },
  {
    tool: "opencode",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" } },
  },
  ...filesOnly("opencode", "rc-key"),
  { tool: "opencode", source: "none", laptop: {} },

  { tool: "pi", source: "file", laptop: { files: { "~/.pi/agent/auth.json": 900 } }, row: { paths: ["~/.pi/agent/auth.json"], default: "skip", starts: "later" } },
  {
    tool: "pi",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" } },
  },
  ...filesOnly("pi", "rc-key"),
  {
    tool: "pi",
    source: "none",
    laptop: {},
  },

  // The device login and the keys file beside it are two rows: the login signs in on the machine, the keys copy.
  {
    tool: "hermes",
    source: "file",
    laptop: { files: { "~/.hermes/.env": 25_000, "~/.hermes/auth.json": 400 } },
    row: { paths: ["~/.hermes/auth.json"], default: "skip", starts: "later" },
  },
  {
    tool: "hermes-keys",
    source: "file",
    laptop: { files: { "~/.hermes/.env": 25_000, "~/.hermes/auth.json": 400 } },
    row: { paths: ["~/.hermes/.env"], default: "bring", detail: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them", starts: "copy" },
  },
  ...(["keychain", "rc-key", "helper"] as const).map((source): Unreachable => ({ tool: "hermes-keys", source, unreachable: "the keys row is the ~/.hermes/.env file alone; a key elsewhere travels as a secret or not at all" })),
  { tool: "hermes-keys", source: "none", laptop: {} },
  {
    tool: "hermes",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" } },
  },
  ...filesOnly("hermes", "rc-key"),
  { tool: "hermes", source: "none", laptop: {} },

  // The 1Password CLI signs in through the desktop app: its row is the binary's presence, and nothing of it travels.
  ...(["keychain", "rc-key", "file", "helper"] as const).map((source): Unreachable => ({ tool: "op", source, unreachable: "op signs in through the 1Password desktop app; nothing of it is copied" })),
  { tool: "op", source: "none", laptop: { which: ["op"] }, row: { paths: [], default: "skip", starts: "later" } },

  // Claude Code: any of these says this computer is signed in, and none of them travels. The workspace reads the
  // long-lived token instead, so every cell makes the same row, with nothing to copy.
  {
    tool: "claude",
    source: "keychain",
    laptop: { exec: { "security find-generic-password -s Claude Code-credentials": "keychain: ...\n" } },
    row: { paths: [], default: "skip", detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels", starts: "token" },
  },
  {
    tool: "claude",
    source: "file",
    laptop: { platform: "linux", files: { "~/.claude/.credentials.json": 800 } },
    row: { paths: [], default: "skip", detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels", starts: "token" },
  },
  {
    tool: "claude",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" } },
    row: { paths: [], default: "skip", detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels", starts: "token" },
  },
  {
    tool: "claude",
    source: "helper",
    laptop: { files: { "~/.claude/settings.json": '{"apiKeyHelper": "security find-generic-password -s anthropic-api-key -w"}' } },
    row: { paths: [], default: "skip", detail: "Claude Code signs in with the token claude setup-token prints on this computer; nothing of its login here travels", starts: "token" },
  },
  { tool: "claude", source: "none", laptop: {} },
];

const cellName = (tool: string, source: Source): string => `${tool} x ${source}`;
const reachable = (c: Cell): c is Reachable => !("unreachable" in c);

describe("the sign-in matrix covers every tool and source", () => {
  const tools = collectorLogins();

  it("has one cell per collector tool and source, names a missing or doubled cell, and lists an unreachable cell with its reason", () => {
    const seen = new Map<string, number>();
    for (const c of MATRIX) seen.set(cellName(c.tool, c.source), (seen.get(cellName(c.tool, c.source)) ?? 0) + 1);
    const missing = tools.flatMap(tool => SOURCES.filter(source => !seen.has(cellName(tool, source))).map(source => cellName(tool, source)));
    const doubled = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    const strays = [...seen.keys()].filter(k => !tools.includes(k.split(" x ")[0]!));
    expect({ missing, doubled, strays }).toEqual({ missing: [], doubled: [], strays: [] });
    for (const c of MATRIX) if (!reachable(c)) expect(c.unreachable, cellName(c.tool, c.source)).not.toBe("");
  });

  it("a source the table lists for a tool has a full cell: the laptop makes the row; a table row nobody collects lists no source", () => {
    for (const [tool, s] of Object.entries(SIGN_INS)) {
      const sources = s.sources;
      if (!tools.includes(tool)) {
        expect(sources, tool).toEqual([]);
        continue;
      }
      for (const source of sources) {
        const cell = MATRIX.find(c => c.tool === tool && c.source === source);
        expect(cell !== undefined && reachable(cell) && cell.row !== undefined, cellName(tool, source)).toBe(true);
      }
    }
    // A cell whose row carries a path to copy is a source the table lists, so the table and the collector cannot
    // drift apart silently. A row with nothing to copy is a tool whose login never travels, and its table row
    // lists no source at all.
    for (const c of MATRIX) {
      if (!reachable(c) || c.row === undefined || c.source === "none") continue;
      const s = SIGN_INS[c.tool]!;
      const lists = (s.sources as readonly string[]).includes(c.source);
      expect(c.row.paths.length > 0 ? lists : s.sources.length === 0, cellName(c.tool, c.source)).toBe(true);
    }
  });
});

describe("the sign-in matrix, cell by cell", () => {
  it.each(MATRIX.map(c => ({ name: cellName(c.tool, c.source), c })))("$name", async ({ c }) => {
    if (!reachable(c)) {
      if (c.laptop === undefined) return;
      const rows = await detectLogins(fakeHost(c.laptop));
      expect(rows.filter(r => r.id === `logins/${c.tool}`), c.unreachable).toEqual([]);
      return;
    }
    // This source alone, the row the collector makes of it, and no value from the laptop in it.
    const rows = await detectLogins(fakeHost(c.laptop));
    const own = rows.filter(r => r.id === `logins/${c.tool}`);
    if (c.row === undefined) expect(own).toEqual([]);
    else {
      const { starts, ...row } = c.row;
      expect(own).toEqual([expect.objectContaining({ rung: "logins", id: `logins/${c.tool}`, ...row })]);
      // The sign-in column: what the Sign-ins screen starts the row at, the wizard's reading of the collector's row.
      expect(initialChoice(own[0]!), `${cellName(c.tool, c.source)} starts`).toBe(starts);
    }
    for (const v of FAKE_VALUES) expect(JSON.stringify(rows)).not.toContain(v);
  });
});
