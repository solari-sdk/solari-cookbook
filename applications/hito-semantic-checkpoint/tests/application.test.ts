import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  observe,
  checkpoint,
  reopen,
  takeover,
  parseCheckpoint,
} from "../src/checkpoint.ts";
import { demo } from "../src/takeover.ts";
import { terminate, boundedFetch } from "../src/solari.ts";
import { receipt } from "../src/receipt.ts";
import type { Compute, Sandbox } from "../src/types.ts";
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
function fixture(mode = "same-state") {
  const root = mkdtempSync(join(tmpdir(), "hito-public-test-"));
  cpSync(new URL("../fixtures/" + mode + "/", import.meta.url), root, {
    recursive: true,
  });
  return root;
}
function withFixture(fn: (root: string) => void) {
  const root = fixture();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("portable checkpoint reopens at a different local root", () =>
  withFixture((a) => {
    const b = fixture();
    try {
      const prior = checkpoint(observe(a));
      assert.deepEqual(reopen(prior), observe(b));
      assert.deepEqual(takeover(b, prior).changed, []);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  }));
test("changed physical support is stale and blocks unsupported continuation", () =>
  withFixture((root) => {
    const prior = checkpoint(observe(root));
    writeFileSync(join(root, "src/index.js"), "changed");
    const t = takeover(root, prior);
    assert.deepEqual(t.changed, ["src/index.js"]);
    assert(
      t.historicalClaims
        .filter((c: any) => c.scope.path === "src/index.js")
        .every((c: any) => c.currentness === "STALE"),
    );
    assert.equal(t.nextStep.state, "RECONCILIATION_REQUIRED");
    assert.equal(t.nextStep.mutatingCommand, null);
  }));
test("same state retains supported currentness, not verified behavior", () =>
  withFixture((root) => {
    const t = takeover(root, checkpoint(observe(root)));
    assert(t.historicalClaims.every((c: any) => c.currentness === "CURRENT"));
    assert(t.current.claims.every((c: any) => c.verification !== "VERIFIED"));
    assert.equal(t.contradictions.assessment, "INDETERMINATE");
  }));
test("unknowns and false authority survive checkpoint restoration", () =>
  withFixture((root) => {
    const o = observe(root),
      t = takeover(root, checkpoint(o));
    assert.deepEqual(t.unknowns, o.unknowns);
    assert.deepEqual(t.authority, {
      canonicalAuthority: false,
      executionAuthority: false,
    });
  }));
test("oversized current file yields unknown currentness instead of current", () =>
  withFixture((root) => {
    const prior = checkpoint(observe(root));
    writeFileSync(join(root, "src/index.js"), "x".repeat(65537));
    const t = takeover(root, prior);
    assert.deepEqual(t.uncertain, ["src/index.js"]);
    assert(
      t.historicalClaims
        .filter((c: any) => c.scope.path === "src/index.js")
        .every((c: any) => c.currentness === "UNKNOWN"),
    );
  }));
test("deleted support invalidates old physical claims", () =>
  withFixture((root) => {
    const prior = checkpoint(observe(root));
    rmSync(join(root, "src/index.js"));
    assert.deepEqual(takeover(root, prior).changed, ["src/index.js"]);
  }));
test("invalid UTF8 is not accepted as observed bytes", () =>
  withFixture((root) => {
    writeFileSync(join(root, "src/index.js"), Buffer.from([255]));
    assert.equal(observe(root).artifacts[2].state, "UNAVAILABLE");
  }));
test("extra unrelated file is outside bounded scope", () =>
  withFixture((root) => {
    const prior = checkpoint(observe(root));
    writeFileSync(join(root, "unrelated.txt"), "unobserved");
    assert.deepEqual(takeover(root, prior).changed, []);
  }));
test("checkpoint corruption rejected", () =>
  withFixture((root) => {
    const prior = checkpoint(observe(root));
    prior.sha256 = "0".repeat(64);
    assert.throws(() => reopen(prior));
  }));
for (const [name, mutate] of [
  [
    "authority escalation",
    (x: any) => {
      x.observation.authority.executionAuthority = true;
    },
  ],
  [
    "unknown removal",
    (x: any) => {
      x.observation.unknowns = [];
    },
  ],
  [
    "fabricated next step",
    (x: any) => {
      x.observation.nextStep.state = "EXECUTE";
    },
  ],
  [
    "subject mismatch",
    (x: any) => {
      x.subjectIdentity = "different";
    },
  ],
  [
    "claim forgery",
    (x: any) => {
      x.observation.claims[0].verification = "VERIFIED";
    },
  ],
  [
    "artifact class forgery",
    (x: any) => {
      x.observation.artifacts[0].authority = "PHYSICAL_OBSERVATION";
    },
  ],
  [
    "support bytes forgery",
    (x: any) => {
      x.observation.artifacts[0].content = "altered";
    },
  ],
  [
    "extra canonical field",
    (x: any) => {
      x.observation.canonicalModel = {};
    },
  ],
] as const)
  test(name + " rejected even with recomputed transport hash", () =>
    withFixture((root) => {
      const prior = checkpoint(observe(root));
      mutate(prior.payload);
      prior.sha256 = sha(JSON.stringify(prior.payload));
      assert.throws(() => reopen(prior));
    }),
  );
test("checkpoint size cap enforced", () =>
  assert.throws(() => parseCheckpoint(" ".repeat(524289))));
test("reobservation does not mutate historical checkpoint", () =>
  withFixture((root) => {
    const prior = checkpoint(observe(root)),
      saved = JSON.stringify(prior);
    takeover(root, prior);
    assert.equal(JSON.stringify(prior), saved);
  }));
class LocalSandbox implements Sandbox {
  id: string;
  root = mkdtempSync(join(tmpdir(), "hito-public-remote-"));
  killed = false;
  killFails = false;
  commandFails = false;
  errorText = "synthetic";
  corruptSource = false;
  writes: string[] = [];
  constructor(id: string) {
    this.id = id;
  }
  async connect() {}
  close() {}
  async kill() {
    if (this.killFails) throw Error("synthetic");
    this.killed = true;
  }
  files = {
    write: async (name: string, data: string | Uint8Array) => {
      assert(name.startsWith("/tmp/hito-semantic-checkpoint/"));
      this.writes.push(name);
      const local = join(
        this.root,
        name.slice("/tmp/hito-semantic-checkpoint/".length),
      );
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(
        local,
        this.corruptSource && name.endsWith("/src/index.js")
          ? "unexpected source"
          : data,
      );
    },
  };
  commands = {
    run: async (
      _cmd: string,
      options: { args: string[]; timeoutMs: number },
    ) => {
      if (this.commandFails)
        return { exitCode: 1, stdout: "", stderr: this.errorText };
      const args = options.args,
        project = join(this.root, "project");
      mkdirSync(join(project, "src"), { recursive: true });
      let value: any;
      if (args[1] === "capture") {
        value = checkpoint(observe(project));
        mkdirSync(join(project, ".maat"));
        writeFileSync(
          join(project, ".maat/solari-public-checkpoint.json"),
          JSON.stringify(value),
        );
      } else if (args[1] === "takeover") {
        value = takeover(
          project,
          JSON.parse(
            readFileSync(
              join(project, ".maat/solari-public-checkpoint.json"),
              "utf8",
            ),
          ),
        );
      } else if (args[1]?.startsWith("test ! -e")) {
        assert(!existsSync(join(project, ".maat")));
        mkdirSync(join(project, ".maat"));
      }
      return {
        exitCode: 0,
        stdout: value ? JSON.stringify(value) : "local test transport",
        stderr: "",
      };
    },
  };
}
class LocalCompute implements Compute {
  sandboxes: LocalSandbox[] = [];
  duplicate = false;
  killFails = false;
  getState = "gone";
  getError: unknown;
  commandFails = false;
  errorText = "synthetic";
  corruptSource = false;
  async create() {
    const s = new LocalSandbox(
      this.duplicate ? "same-id" : "local-" + this.sandboxes.length,
    );
    s.killFails = this.killFails;
    s.commandFails = this.commandFails;
    s.errorText = this.errorText;
    s.corruptSource = this.corruptSource;
    this.sandboxes.push(s);
    return s;
  }
  async get() {
    if (this.getError) throw this.getError;
    return { state: this.getState };
  }
  cleanup() {
    for (const s of this.sandboxes)
      rmSync(s.root, { recursive: true, force: true });
  }
}
for (const mode of ["same", "changed"] as const)
  test(
    mode + " full controller flow using local real file observations",
    async () => {
      const c = new LocalCompute();
      try {
        const e = await demo(c, mode);
        assert.equal(e.result, "PASS");
        assert.equal(c.sandboxes.length, 2);
        assert(c.sandboxes.every((s) => s.killed));
        assert(e.sessions.every((s) => s.termination?.terminated));
        assert.notEqual(e.sessions[0].id, e.sessions[1].id);
        assert(e.takeover.reobserved.length === 3);
        assert.match(receipt(e), /EXECUTION|Execution/);
        assert.match(receipt(e), /STILL UNKNOWN/);
      } finally {
        c.cleanup();
      }
    },
  );
test("unconfirmed A termination prevents B creation", async () => {
  const c = new LocalCompute();
  c.getState = "running";
  try {
    const e = await demo(c, "same");
    assert.equal(e.result, "FAIL");
    assert.equal(c.sandboxes.length, 1);
  } finally {
    c.cleanup();
  }
});
test("kill failure prevents B creation", async () => {
  const c = new LocalCompute();
  c.killFails = true;
  try {
    assert.equal((await demo(c, "same")).result, "FAIL");
    assert.equal(c.sandboxes.length, 1);
  } finally {
    c.cleanup();
  }
});
test("duplicate sandbox identity fails and still attempts cleanup", async () => {
  const c = new LocalCompute();
  c.duplicate = true;
  try {
    assert.equal((await demo(c, "same")).result, "FAIL");
    assert(c.sandboxes.every((s) => s.killed));
  } finally {
    c.cleanup();
  }
});
test("guest command failure still terminates A", async () => {
  const c = new LocalCompute();
  c.commandFails = true;
  try {
    assert.equal((await demo(c, "same")).result, "FAIL");
    assert(c.sandboxes[0].killed);
    assert.equal(c.sandboxes.length, 1);
  } finally {
    c.cleanup();
  }
});
test("unexpected original source cannot become a passing X capture", async () => {
  const c = new LocalCompute();
  c.corruptSource = true;
  try {
    assert.equal((await demo(c, "changed")).result, "FAIL");
    assert.equal(c.sandboxes.length, 1);
    assert(c.sandboxes[0].killed);
  } finally {
    c.cleanup();
  }
});
test("remote error credential text is never persisted or printed by controller", async () => {
  const c = new LocalCompute();
  c.commandFails = true;
  c.errorText = "SYNTHETIC_PRIVATE_VALUE";
  const progress: string[] = [],
    saved: string[] = [];
  try {
    const e = await demo(
      c,
      "same",
      (x) => progress.push(x),
      (x) => saved.push(JSON.stringify(x)),
    );
    assert(!JSON.stringify([progress, saved, e]).includes(c.errorText));
  } finally {
    c.cleanup();
  }
});
test("structured 404 after acknowledged kill is accepted", async () => {
  const c = new LocalCompute();
  c.getError = { status: 404 };
  const s = await c.create();
  try {
    assert.equal((await terminate(c, s)).terminated, true);
  } finally {
    c.cleanup();
  }
});
test("prose 404 is not termination evidence", async () => {
  const c = new LocalCompute();
  c.getError = Error("404 not found");
  const s = await c.create();
  try {
    await assert.rejects(() => terminate(c, s));
  } finally {
    c.cleanup();
  }
});
test("string status is not structured 404", async () => {
  const c = new LocalCompute();
  c.getError = { status: "404" };
  const s = await c.create();
  try {
    await assert.rejects(() => terminate(c, s));
  } finally {
    c.cleanup();
  }
});
test("third create dispatch rejected", async () => {
  let calls = 0;
  const guarded = boundedFetch(async () => {
    calls++;
    return new Response("{}");
  }, 2);
  for (const key of ["a", "b"])
    await guarded("https://example.invalid/sandboxes", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: "{}",
    });
  await assert.rejects(() =>
    guarded("https://example.invalid/sandboxes", {
      method: "POST",
      headers: { "Idempotency-Key": "c" },
      body: "{}",
    }),
  );
  assert.equal(calls, 2);
});
test("SDK create retry rejected", async () => {
  let calls = 0;
  const guarded = boundedFetch(async () => {
    calls++;
    throw Error("synthetic timeout");
  }, 2);
  for (let i = 0; i < 2; i++)
    await assert.rejects(() =>
      guarded("https://example.invalid/sandboxes", {
        method: "POST",
        headers: { "Idempotency-Key": "same" },
        body: "{}",
      }),
    );
  assert.equal(calls, 1);
});
test("snapshot API dispatch rejected", async () => {
  const guarded = boundedFetch(async () => {
    throw Error("must not dispatch");
  }, 2);
  await assert.rejects(() => guarded("https://example.invalid/snapshots"));
});
test("receipt carries no invented completed work when takeover missing", () => {
  const text = receipt({
    mode: "same",
    result: "FAIL",
    sessions: [],
    errors: ["incomplete"],
    scope: "test",
  });
  assert.match(text, /Takeover evidence unavailable/);
  assert.doesNotMatch(text, /RESULT: PASS/);
});
test("only Solari credential requested by CLI; absent credential makes no live call", () => {
  const child = spawnSync(process.execPath, ["src/index.ts"], {
    cwd: new URL("../", import.meta.url),
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /SOLARI_API_KEY is required/);
});
test("registry-only dependency set excludes model SDKs and private paths", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@solarisdk/browser", "@solarisdk/sandbox"]);
  assert(
    Object.values({ ...pkg.dependencies, ...pkg.devDependencies }).every((v) =>
      /^\d+\.\d+\.\d+$/.test(String(v)),
    ),
  );
});
