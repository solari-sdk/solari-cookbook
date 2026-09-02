import { Command } from "commander";
import type { CliOptions } from "./types.js";

export function buildCli(): Command {
  const program = new Command();

  program
    .name("mergelab")
    .description("Integration-risk simulator for GitHub pull requests")
    .version("0.1.0")
    .requiredOption("--repo <url>", "public GitHub repository URL")
    .requiredOption("--prs <numbers>", "comma-separated list of 2–3 PR numbers")
    .requiredOption("--config <path>", "path to mergelab.config.json")
    .option("--base-sha <sha>", "explicit immutable base commit")
    .option("--mode <mode>", "pairwise or selected", "pairwise")
    .option("--combination <ids>", "explicit candidate such as 21+22")
    .option("--concurrency <n>", "maximum simultaneous workers", "2")
    .option("--output <dir>", "write result.json and artifacts to this directory")
    .option("--keep-sandboxes", "retain environments for debugging", false)
    .option("--html", "generate an HTML report in addition to result.json", false)
    .option("--no-ai", "omit AI explanation without disabling factual analysis");

  return program;
}

export function parseCli(argv: string[]): CliOptions {
  const program = buildCli();
  program.parse(argv);
  const opts = program.opts();

  const rawPrs = String(opts.prs)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10));

  if (rawPrs.length < 2 || rawPrs.length > 3) {
    throw new Error("--prs must contain 2–3 unique PR numbers");
  }

  if (new Set(rawPrs).size !== rawPrs.length) {
    throw new Error("--prs must contain unique PR numbers");
  }

  if (rawPrs.some(Number.isNaN)) {
    throw new Error("--prs must contain valid integers");
  }

  const mode = opts.mode;
  if (mode !== "pairwise" && mode !== "selected") {
    throw new Error("--mode must be 'pairwise' or 'selected'");
  }

  const concurrency = Number.parseInt(opts.concurrency, 10);
  if (Number.isNaN(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }

  return {
    repo: String(opts.repo),
    prs: rawPrs,
    config: String(opts.config),
    baseSha: opts.baseSha ? String(opts.baseSha) : undefined,
    mode,
    combination: opts.combination ? String(opts.combination) : undefined,
    concurrency,
    output: opts.output ? String(opts.output) : undefined,
    keepSandboxes: Boolean(opts.keepSandboxes),
    ai: opts.ai,
    html: Boolean(opts.html),
  };
}
