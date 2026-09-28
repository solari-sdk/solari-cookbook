import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseCheckpoint } from "./checkpoint.ts";
import { terminate, provision } from "./solari.ts";
import type { Compute, Sandbox, Mode, Evidence } from "./types.ts";
const HOME = "/tmp/hito-semantic-checkpoint",
  ROOT = HOME + "/project";
const files = ["README.md", "package.json", "src/index.js"];
export async function demo(
  client: Compute,
  mode: Mode,
  progress: (text: string) => void = () => {},
  persist: (e: Evidence) => void = () => {},
): Promise<Evidence> {
  const evidence: Evidence = {
    mode,
    result: "FAIL",
    sessions: [],
    errors: [],
    scope:
      "Bounded evidence over three fixture files. PASS is transport/currentness proof, not behavior, deployment readiness or authority.",
  };
  let checkpoint: any;
  const started = Date.now();
  async function arm(label: "A" | "B") {
    if (evidence.sessions.length >= 2) throw Error("TWO_SESSION_LIMIT");
    if (label === "B" && evidence.sessions[0]?.termination?.terminated !== true)
      throw Error("ORIGIN_ABSENCE_REQUIRED");
    const entry: Evidence["sessions"][number] = { label };
    evidence.sessions.push(entry);
    persist(evidence);
    let sandbox: Sandbox | undefined;
    let failure = false;
    async function command(cmd: string, args: string[]) {
      if (Date.now() - started > 240000) throw Error("DEMO_WALL_BUDGET");
      const result = await sandbox!.commands.run(cmd, {
        args,
        timeoutMs: 30000,
      });
      if (result.exitCode !== 0) throw Error("GUEST_COMMAND_FAILED");
      return result.stdout;
    }
    try {
      sandbox = await client.create({
        template: "base",
        cpu: 1,
        memMb: 2048,
        timeoutMs: 60000,
        lifecycle: { onTimeout: "kill" },
      });
      entry.id = sandbox.id;
      persist(evidence);
      if (label === "B" && sandbox.id === evidence.sessions[0].id)
        throw Error("FRESH_SANDBOX_REQUIRED");
      await sandbox.connect();
      progress(
        "SANDBOX " + label + " — " + (label === "A" ? "created" : "fresh"),
      );
      await command("sh", ["-c", provision]);
      for (const name of [
        "hito-observation.cjs",
        "observation.cjs",
        "guest.cjs",
      ])
        await sandbox.files.write(
          HOME + "/" + name,
          readFileSync(new URL(name, import.meta.url)),
        );
      const fixture =
        label === "B" && mode === "changed" ? "changed-state" : "same-state";
      for (const name of files)
        await sandbox.files.write(
          ROOT + "/" + name,
          readFileSync(
            new URL("../fixtures/" + fixture + "/" + name, import.meta.url),
          ),
        );
      if (label === "A") {
        checkpoint = parseCheckpoint(
          await command(HOME + "/node", [HOME + "/guest.cjs", "capture", ROOT]),
        );
        for (const path of files) {
          const expected = createHash("sha256")
            .update(
              readFileSync(
                new URL("../fixtures/same-state/" + path, import.meta.url),
              ),
            )
            .digest("hex");
          if (
            !checkpoint.payload.observation.artifacts.some(
              (a: any) =>
                a.path === path &&
                a.state === "OBSERVED" &&
                a.contentSha256 === expected,
            )
          )
            throw Error("ORIGIN_FIXTURE_NOT_OBSERVED");
        }
        evidence.checkpoint = checkpoint;
        progress("PROJECT X — observed\nSEMANTIC CHECKPOINT — captured");
      } else {
        await command("sh", [
          "-c",
          "test ! -e /tmp/hito-semantic-checkpoint/project/.maat && mkdir /tmp/hito-semantic-checkpoint/project/.maat",
        ]);
        await sandbox.files.write(
          ROOT + "/.maat/solari-public-checkpoint.json",
          JSON.stringify(checkpoint),
        );
        evidence.takeover = JSON.parse(
          await command(HOME + "/node", [
            HOME + "/guest.cjs",
            "takeover",
            ROOT,
          ]),
        );
        progress("CONTINUITY — restored\nCURRENT REALITY — re-observed");
      }
    } catch {
      failure = true;
      evidence.errors.push(
        label + ": operation failed; no remote error text retained.",
      );
    } finally {
      if (sandbox) {
        try {
          entry.termination = await terminate(client, sandbox);
          progress("SANDBOX " + label + " — destroyed (confirmed)");
        } catch {
          failure = true;
          evidence.errors.push(label + ": termination NOT CONFIRMED.");
        } finally {
          sandbox.close();
        }
      } else
        evidence.errors.push(
          label + ": creation outcome unknown; no handle returned.",
        );
      persist(evidence);
    }
    if (failure || !entry.termination?.terminated)
      throw Error("ARM_INCOMPLETE");
  }
  try {
    await arm("A");
    await arm("B");
    const t = evidence.takeover;
    const changed =
      mode === "changed"
        ? t.changed.length === 1 && t.changed[0] === "src/index.js"
        : t.changed.length === 0;
    const current =
      t.reobserved.length === 3 &&
      files.every((path) => {
        const expected = createHash("sha256")
          .update(
            readFileSync(
              new URL(
                "../fixtures/" +
                  (mode === "changed" ? "changed-state" : "same-state") +
                  "/" +
                  path,
                import.meta.url,
              ),
            ),
          )
          .digest("hex");
        return t.reobserved.some(
          (x: any) =>
            x.path === path &&
            x.state === "OBSERVED" &&
            x.contentSha256 === expected,
        );
      });
    const stale =
      mode === "changed"
        ? t.historicalClaims.some(
            (c: any) =>
              c.scope.path === "src/index.js" && c.currentness === "STALE",
          )
        : t.historicalClaims.every((c: any) => c.currentness === "CURRENT");
    const noAuthority =
      t.authority.executionAuthority === false &&
      t.authority.canonicalAuthority === false &&
      t.nextStep.mutatingCommand === null;
    const identity = t.checkpointSha256 === checkpoint.sha256;
    evidence.result =
      changed &&
      current &&
      stale &&
      noAuthority &&
      identity &&
      t.unknowns.length === 3
        ? "PASS"
        : "PARTIAL";
  } catch {
    evidence.result = "FAIL";
  }
  persist(evidence);
  return evidence;
}
