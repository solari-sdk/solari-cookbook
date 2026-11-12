/**
 * Child process for the `browser-lifecycle` check. Not a library entry point.
 *
 * Launches a session, closes the browser, and does not call `solari.close()`.
 * That omission is deliberate: on 0.1.3 the retry listener is unref'd and the
 * process exits anyway; on 0.1.2 it does not (finding F27). The parent observes
 * which occurs.
 *
 * Out-of-process because a process cannot reliably report whether it would
 * itself have hung (design.md §6.3).
 *
 * Protocol: one JSON object per line on stdout. The API key arrives through the
 * environment and is never written to either stream.
 *
 *   usage: node browser-lifecycle-harness.js <projectRoot>
 */

import { readSdkInstall } from "./sdk-install.js";

interface SolariLike {
  launch(): Promise<{ close(): Promise<void> }>;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const projectRoot = process.argv[2];
  const apiKey = process.env["SOLARI_API_KEY"];

  if (projectRoot === undefined || apiKey === undefined || apiKey === "") {
    emit({ phase: "error", name: "HarnessUsage", message: "projectRoot and SOLARI_API_KEY are required" });
    process.exitCode = 2;
    return;
  }

  const install = readSdkInstall(projectRoot);
  if (install.entryUrl === undefined) {
    emit({ phase: "error", name: "SdkNotFound", message: install.problem ?? "no entry point" });
    process.exitCode = 2;
    return;
  }

  // Imported by absolute path so the child exercises the *user's* installed
  // SDK. A bare specifier would resolve to solari-doctor's own copy and the
  // check would report on the wrong version (§19.2).
  const module_ = (await import(install.entryUrl)) as {
    Solari: new (options: { apiKey: string }) => SolariLike;
  };

  emit({ phase: "loaded", sdkVersion: install.version ?? null });

  const solari = new module_.Solari({ apiKey });
  const browser = await solari.launch();
  emit({ phase: "launched" });

  await browser.close();
  emit({ phase: "closed" });

  // Nothing follows. Whether this process exits is what the parent measures.
}

main().catch((error: unknown) => {
  emit({
    phase: "error",
    name: error instanceof Error ? error.constructor.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
