/**
 * CLI entry point. See design.md §9.1 and §13.
 *
 * Wires registry -> scheduler -> diagnosis -> renderer, and owns every write.
 * The layers below return strings and results; nothing else in the codebase
 * touches stdout, stderr or the filesystem.
 *
 * The surface is one command and four flags (design.md §13). There is
 * deliberately no `--help` or subcommand; an unrecognised argument prints usage
 * and exits 2.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registry as defaultRegistry, type CheckRegistry } from "./checks/index.js";
import { createDoctorContext, type DoctorContext } from "./context.js";
import { diagnose } from "./diagnosis/engine.js";
import { DIAGNOSIS_RULES } from "./diagnosis/rules.js";
import { EXPLANATIONS } from "./explain.js";
import { renderReportBundle } from "./report/bundle.js";
import { renderJson } from "./report/json.js";
import { renderTerminal } from "./report/terminal.js";
import { runChecks } from "./runner/scheduler.js";

/** design.md §9.1. `warn` and `skip` exit 0; only a `fail` is exit 1. */
export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_USAGE = 2;

export const REPORT_FILENAME = "solari-doctor-report.json";

const USAGE = [
  "usage: solari-doctor [--json] [--full] [--explain <id>] [--report]",
  "",
  "  --json          machine-readable output on stdout",
  "  --full          also run expensive checks",
  "  --explain <id>  print the documented finding for one check",
  "  --report        write a sanitised report to ./solari-doctor-report.json",
].join("\n");

export interface CliOptions {
  json: boolean;
  full: boolean;
  report: boolean;
  explain?: string;
}

export type ParseResult =
  | { ok: true; options: CliOptions }
  | { ok: false; message: string };

/** Parses argv. Pure; no I/O and no process access. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const options: CliOptions = { json: false, full: false, report: false };
  let explain: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--full":
        options.full = true;
        break;
      case "--report":
        options.report = true;
        break;
      case "--explain": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) {
          return { ok: false, message: "--explain requires a check id" };
        }
        explain = value;
        i += 1;
        break;
      }
      default:
        return { ok: false, message: `unknown argument: ${String(arg)}` };
    }
  }

  return {
    ok: true,
    options: { ...options, ...(explain !== undefined ? { explain } : {}) },
  };
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  writeFile(path: string, contents: string): void;
}

export interface CliDeps {
  io: CliIo;
  registry?: CheckRegistry;
  context?: DoctorContext;
  cwd?: string;
  /** Colour is enabled only for an interactive stdout with NO_COLOR unset. */
  color?: boolean;
  /**
   * Environment the context is built from. Injected rather than read inside
   * `createDoctorContext` so that a test which does not supply a context is
   * unaffected by whatever is exported in the shell running it.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Prints the stored explanation for a check id.
 *
 * Performs no network call: design.md §6.7 requires the issue #25 finding to be
 * surfaced without being re-verified.
 */
function explainCheck(id: string, io: CliIo): number {
  const text = EXPLANATIONS[id];
  if (text === undefined) {
    const known = Object.keys(EXPLANATIONS).sort();
    io.stderr(
      known.length > 0
        ? `no explanation for "${id}". available: ${known.join(", ")}\n`
        : `no explanation for "${id}". none are available yet.\n`,
    );
    return EXIT_USAGE;
  }
  io.stdout(`${text}\n`);
  return EXIT_OK;
}

/**
 * Runs the CLI and returns the process exit code.
 *
 * Returns rather than calling `process.exit` so the whole surface is testable
 * without spawning a process.
 */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.io.stderr(`${parsed.message}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  const { options } = parsed;
  const io = deps.io;

  if (options.explain !== undefined) {
    return explainCheck(options.explain, io);
  }

  const registry = deps.registry ?? defaultRegistry;
  const env = deps.env ?? {};
  const context =
    deps.context ??
    createDoctorContext({
      apiKey: env["SOLARI_API_KEY"],
      ...(deps.cwd !== undefined ? { projectRoot: deps.cwd } : {}),
    });

  let results;
  try {
    results = await runChecks(registry, context, { full: options.full });
  } finally {
    // One owner, one disposal, after every check has finished.
    await context.dispose();
  }
  const diagnoses = diagnose(results, DIAGNOSIS_RULES);

  io.stdout(
    options.json
      ? renderJson(results, diagnoses)
      : renderTerminal(results, diagnoses, { color: deps.color ?? false }),
  );

  if (options.report) {
    const path = join(deps.cwd ?? process.cwd(), REPORT_FILENAME);
    try {
      io.writeFile(
        path,
        renderReportBundle({
          results,
          diagnoses,
          ...(context.region !== undefined ? { region: context.region } : {}),
          ...(context.baseUrl !== undefined ? { baseUrl: context.baseUrl } : {}),
        }),
      );
      // stderr, so `--json --report > out.json` leaves stdout uncorrupted.
      io.stderr(`report written to ${path}\n`);
    } catch (error) {
      // The diagnosis has already been printed and is what the run was for.
      // Losing the report file is worth a warning, not the loss of the verdict.
      io.stderr(
        `could not write ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  return results.some((result) => result.status === "fail")
    ? EXIT_CHECK_FAILED
    : EXIT_OK;
}

/** Default wiring for the real process. */
export async function main(argv: readonly string[]): Promise<number> {
  const color = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
  return runCli(argv, {
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      writeFile: (path, contents) => writeFileSync(path, contents, "utf8"),
    },
    color,
    env: process.env,
  });
}
