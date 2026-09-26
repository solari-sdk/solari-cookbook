// SPDX-License-Identifier: AGPL-3.0-only
// The vault step of wsp init, the one sign-in stage that runs on this computer
// and touches no machine. A row whose tool mints a long-lived token has that
// command run here, in the person's own terminal, and the token they are shown
// is pasted into a hidden prompt; a row answered with an API key is asked for
// the key the same way. Both are saved to the wsp home's .env, mode 0600, and
// the runtime sets them in the environment of every turn. Nothing of either is
// written to a machine, so nothing credential-shaped can reach an image.
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { S_BAR, isCancel, log } from "@clack/prompts";
import { catalogEntry, keyEnvOf, loginSignIn, mintsToken, tokenIn, type TokenSignIn } from "@wsp/catalog";
import type { ManifestEntry } from "@wsp/collect";
import { passwordPrompt } from "./init-layout.js";
import { agentName, loginEntryId } from "./init-recipe.js";
import { stateLine, type LoginOutcome } from "./init-signin.js";

/** One row the vault step owns: the variable it holds, and the command that mints its value on this computer when
 * the tool has one. A token row carries the catalog row that says what a paste has to be. */
export interface VaultRow {
  entry: ManifestEntry;
  /** The variable the wsp home's .env holds it under, and the turn's environment gets. */
  name: string;
  /** The words the row and its outcome use: "token" or "API key". */
  word: string;
  /** The tool's own command for minting a token here; absent on a row answered with a key. */
  mint?: string;
  /** The catalog's token row, which says what a paste has to be; absent on a row answered with a key. */
  row?: TokenSignIn;
}

const TOKEN_WORD = "token";
const KEY_WORD = "API key";

/** The rows the vault step owns: a sign-in answered `token`, whose tool mints one here, and one answered `key`,
 * whose tool reads an API key. Read off the catalog row, so a tool that starts minting a token is one row's edit. */
export function vaultRows(manifest: { entries: readonly ManifestEntry[] }, choices: ReadonlyMap<string, string>): VaultRow[] {
  return manifest.entries.flatMap((entry): VaultRow[] => {
    if (entry.rung !== "logins") return [];
    const choice = choices.get(entry.id);
    if (choice !== "token" && choice !== "key") return [];
    const signIn = loginSignIn(entry.id);
    if (signIn === undefined) return [];
    if (choice === "token") {
      return mintsToken(signIn) ? [{ entry, name: signIn.tokenEnv, word: TOKEN_WORD, mint: signIn.mint, row: signIn }] : [];
    }
    const keyEnv = keyEnvOf(signIn);
    return keyEnv === undefined ? [] : [{ entry, name: keyEnv, word: KEY_WORD }];
  });
}

/** The name the row's tool goes by in a question. */
const toolName = (row: VaultRow): string => catalogEntry(loginEntryId(row.entry))?.name ?? row.entry.label;

/** What a row that is already in the vault says: held here, nothing run and nothing asked. */
const heldNote = (word: string): string => `${word} held on this computer`;

export interface VaultStageOptions {
  rows: readonly VaultRow[];
  /** What the wsp home's .env holds, read when the step reaches a row: on the hand-off road the client saves the
   * value while the step waits, and a record read once would not see it land. */
  held(): Readonly<Record<string, string>>;
  /** Set where nobody is at this terminal but a client is: the step says what it needs, then waits this long for
   * the value to reach the wsp home (the client sends it as the job's sign-in code). */
  waitMs?: number;
  /** One object per row: the same two the sign-ins on a machine print, so a client draws these rows the same way.
   * A row of this step waits on a paste rather than a page, which is what `waitingFor` names. */
  json?(record: Record<string, unknown>): void;
  now?: () => number;
  /** Writes the values into the wsp home's .env, mode 0600. */
  save(set: Record<string, string>): void;
  /** Runs a row's mint command here with the person's own terminal, so they see its page and its answer; the value
   * is read from what they paste, never off its output. Absent leaves the command for them to run themselves. */
  mint?(command: string): Promise<void>;
  input: Readable;
  output: Writable;
  /** Set when nobody can type here (no terminal, or --yes): every row is left with this note. */
  skipWhy?: string;
  /** Keeps the value out of the run log. */
  hide?(value: string): void;
}

const dim = (s: string): string => styleText("dim", s);

/** How often the wsp home is read again while the hand-off waits for a client to save a value there. */
const WAIT_POLL_MS = 500;

/** Runs a row's mint command on this computer with this terminal, so the person sees its page and what it prints
 * and answers its prompts. Its output is never read: the whole flow is theirs, and the value comes from the paste
 * below. Measured on Claude Code 2.1.257: the command draws its browser link and its own prompt on stdout, so a
 * run whose stdout was captured would leave the person with a blank terminal and nothing to approve. */
export function runMintHere(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

/** The values the person holds on this computer, asked for once each and saved together. A row whose value is
 * already in the wsp home's .env is signed in where it stands; one nobody typed is not signed in, and says so. */
export async function vaultStage(o: VaultStageOptions): Promise<LoginOutcome[]> {
  const out = { output: o.output };
  const outcomes = o.rows.map((row): LoginOutcome => ({ id: row.entry.id, label: row.entry.label, state: "skipped" }));
  if (o.rows.length === 0) return outcomes;
  const set: Record<string, string> = {};
  const now = o.now ?? Date.now;
  const holds = (row: VaultRow): boolean => {
    const value = o.held()[row.name];
    return value !== undefined && value !== "";
  };
  const said = (row: VaultRow, r: LoginOutcome): void => {
    o.json?.({ event: "sign-in-result", tool: agentName(row.entry), label: r.label, state: r.state, ...(r.note !== undefined ? { note: r.note } : {}) });
    log.message(stateLine(r), { output: o.output, symbol: dim(S_BAR) });
  };
  const settle = (row: VaultRow, r: LoginOutcome): void => {
    r.state = "signed-in";
    r.note = heldNote(row.word);
    said(row, r);
  };
  const pairs = o.rows.map((row, i): [VaultRow, LoginOutcome] => [row, outcomes[i]!]);
  const standing: [VaultRow, LoginOutcome][] = [];
  for (const [row, r] of pairs) {
    if (holds(row)) settle(row, r);
    else standing.push([row, r]);
  }
  if (standing.length === 0) return outcomes;
  // Nobody at this terminal and a client driving the run: the row says what it needs and waits for that client to
  // save it, which is the same file this reads. Nothing runs on a machine either way.
  if (o.waitMs !== undefined) {
    for (const [row, r] of standing) {
      o.json?.({ event: "sign-in", tool: agentName(row.entry), label: r.label, waitingFor: row.word, variable: row.name, ...(row.mint !== undefined ? { mint: row.mint } : {}) });
      log.step([`${r.label}: ${row.mint === undefined ? `paste the ${row.word} from the app` : `run ${row.mint} on this computer and paste what it prints into the app`}`, dim(`it is saved in your wsp home as ${row.name} and set on every turn; nothing of it reaches a machine`)].join("\n"), out);
      const until = now() + o.waitMs;
      while (!holds(row) && now() < until) await new Promise(r2 => setTimeout(r2, WAIT_POLL_MS));
      if (holds(row)) settle(row, r);
      else {
        r.state = "not-signed-in";
        r.note = `no ${row.word} came within ${Math.round(o.waitMs / 60_000)} min`;
        said(row, r);
      }
    }
    return outcomes;
  }
  if (o.skipWhy !== undefined) {
    for (const [row, r] of standing) {
      r.state = "not-signed-in";
      r.note = o.skipWhy;
      o.json?.({ event: "sign-in-result", tool: agentName(row.entry), label: r.label, state: r.state, note: r.note });
    }
    log.step(`Nothing asked for on this computer: ${standing.map(([, r]) => r.label).join(", ")}. ${o.skipWhy[0]!.toUpperCase()}${o.skipWhy.slice(1)}.`, out);
    return outcomes;
  }
  log.step("These stay on this computer: they are saved in your wsp home and set on every turn, never on a machine.", out);
  for (const [row, r] of standing) {
    if (row.mint !== undefined) {
      log.message(`${r.label}${dim(`  ${row.mint}`)}\n${dim("it runs here, in this terminal; approve it in your browser and paste what it prints")}`, { output: o.output, symbol: dim(S_BAR) });
      if (o.mint !== undefined) {
        try {
          await o.mint(row.mint);
        } catch (e) {
          log.warn(`${row.mint} did not run here (${e instanceof Error ? e.message : String(e)}); run it yourself and paste the ${row.word}.`, out);
        }
      }
    }
    const typed = await passwordPrompt({
      message: `${toolName(row)} ${row.word}`,
      hint: `saved in your wsp home as ${row.name} and set on every turn; never shown here and never on a machine`,
      input: o.input,
      output: o.output,
    });
    const pasted = isCancel(typed) ? "" : typed.trim();
    // A token row takes the token out of the paste, which is the whole of it or nothing; a key row takes what was
    // typed, since no tool declares a shape for one.
    const value = row.row === undefined ? pasted : (tokenIn(row.row, pasted) ?? "");
    if (pasted === "") {
      r.state = "not-signed-in";
      r.note = `no ${row.word} typed`;
    } else if (value === "") {
      r.state = "not-signed-in";
      r.note = `that is not what ${row.mint ?? toolName(row)} prints; nothing was saved`;
    } else {
      o.hide?.(value);
      set[row.name] = value;
      r.state = "signed-in";
      r.note = heldNote(row.word);
    }
    said(row, r);
  }
  if (Object.keys(set).length > 0) o.save(set);
  return outcomes;
}
