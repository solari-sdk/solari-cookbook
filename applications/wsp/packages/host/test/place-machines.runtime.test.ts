// SPDX-License-Identifier: AGPL-3.0-only
// The round trip of place-machines.test.ts with this computer's own workspace
// runtime on the far side: the Rust daemon, started by the test as a place with
// a throwaway root, answering the same frames from the kernel instead of a
// Docker daemon. One daemon serves every case here, so the file holds its own
// lifecycle instead of the Docker file's per-case sweep. Root, cgroup v2 and a
// registry are what it needs, so it runs under WSP_RUNTIME_LIVE=1 alone. The deploy case puts the daemon onto a
// workspace and reads its hello back through the forward, which takes apt, nodejs.org and npm from inside. The
// pause cases are this computer's own: the nap that stops a workspace, the wake that boots it again over what it
// wrote, and the quiet figure this host reads off the far side before it stops one.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import type { DaemonEvent } from "@wsp/protocol";
import { DAEMON_TOKEN_PATH, GUEST_WSP_HOME, NO_IMAGES_HERE } from "@wsp/protocol";
import { LinkBackend, OWNER_LABEL, type ExecResult, type Machine, type MachineSpec } from "@wsp/engine";
import { connectDaemon } from "@wsp/runtime";
import { closeFakePlaceHosts, fakePlaceHost, placePair, testPlaceFile } from "../../daemon/test/fake-place-host.js";
import { daemonBin, spawnDaemon, type DaemonUnderTest } from "../../daemon/test/harness.js";
import { deployDaemon } from "../src/doctor.js";
import { linkOver } from "./machine-link.js";

const RUNTIME_LIVE = process.env["WSP_RUNTIME_LIVE"] === "1";
/** This run's own label, so two suites on one box never list or kill each other's workspaces. */
const LIVE_OWNER = `live-665-${process.pid}`;
const CGROUPS = "/sys/fs/cgroup/wsp";
/** A line answered on the workspace's port 7070 from every address it has; the base image carries perl and nothing
 * else that listens. */
const ANSWER_ON_7070 = "nohup perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"0.0.0.0\", LocalPort => 7070, Listen => 5, ReuseAddr => 1) or die $!; while ($c = $s->accept) { print $c \"hello from inside\\n\"; close $c }' > /dev/null 2> /tmp/listen.err & sleep 0.5; cat /tmp/listen.err";

/** One line read off a fresh connection to the box's loopback port, inside two seconds. */
const readLine = (port: number): Promise<string> =>
  new Promise((done, fail) => {
    const socket = connect({ host: "127.0.0.1", port });
    let text = "";
    socket.setTimeout(2_000, () => fail(new Error(`127.0.0.1:${port} answered nothing in 2 s`)));
    socket.on("data", chunk => {
      text += String(chunk);
      if (text.includes("\n")) socket.end();
    });
    socket.on("error", fail);
    socket.on("close", () => done(text.trim()));
  });

describe.skipIf(!RUNTIME_LIVE)("the whole road, over a daemon link a place proved, with the runtime on the far side", () => {
  let daemon: DaemonUnderTest;
  let backend: LinkBackend;
  let root: string;
  const made: Machine[] = [];
  const times: Record<string, number> = {};
  /** The daemon's home and its runtime root, removed once at the end: the root holds a mounted rootfs for as long
   * as a workspace runs. */
  const own: string[] = [];
  const ownDir = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), name));
    own.push(dir);
    return dir;
  };

  const create = async (spec: MachineSpec): Promise<Machine> => {
    const started = Date.now();
    const machine = await backend.create({ ...spec, labels: { [OWNER_LABEL]: LIVE_OWNER, ...spec.labels } });
    times["create to ready"] = Date.now() - started;
    made.push(machine);
    return machine;
  };
  const exec = async (machine: Machine, cmd: string): Promise<ExecResult> => machine.exec(cmd, { timeoutMs: 60_000 });
  const cgroupOf = (id: string): string => join(CGROUPS, id);

  beforeAll(async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const file = testPlaceFile([host.url], key.publicKey, placePair().privateKeyPem);
    const home = ownDir("wsp-runtime-home-");
    root = ownDir("wsp-runtime-root-");
    const tokenPath = join(home, "token");
    writeFileSync(tokenPath, "link-token\n");
    daemon = await spawnDaemon(daemonBin(), { host: "127.0.0.1", port: 0, tokenPath, kind: "place", root: home, home, placeFile: file, rootsPath: join(home, "roots"), runtimeRoot: root }, { startMs: 20_000 });
    const socket = await host.socket;
    backend = await LinkBackend.open(linkOver(socket as unknown as WebSocket));
    expect(backend.capabilities.pauseMode).toBe("disk");
  }, 60_000);

  afterAll(async () => {
    const ids = made.map(machine => machine.id);
    for (const machine of made.splice(0)) await machine.kill().catch(() => undefined);
    expect(await backend.list({ [OWNER_LABEL]: LIVE_OWNER })).toEqual([]);
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(root);
    // Only this run's cgroups: another suite on the box may have workspaces of its own.
    expect(existsSync(CGROUPS) ? readdirSync(CGROUPS).filter(name => ids.includes(name)) : []).toEqual([]);
    const status = readFileSync(`/proc/${daemon.pid}/status`, "utf8");
    times["daemon VmRSS kB"] = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]);
    await daemon.close();
    await closeFakePlaceHosts();
    for (const dir of own.splice(0)) rmSync(dir, { recursive: true, force: true });
    console.log(`runtime timings: ${JSON.stringify(times)}`);
  }, 60_000);

  it("builds the container from the spec: image, limits, labels, envs and the boot command", async () => {
    const key = `live-665-build-${process.pid}`;
    // Two cores of a box that keeps one for itself, read off the box rather than written down here.
    const cores = (await backend.capacity()).cores;
    const givenCpu = Math.min(2, Math.max(1, cores - 1));
    const machine = await create({ kind: "sandbox", cpu: 2, memMb: 1024, envs: { WSP_TOKEN: "t" }, labels: { row: "build" }, idempotencyKey: key });
    expect(machine.id).toBe(`wsp-${key}`);
    expect(await machine.state()).toBe("running");
    const seen = await exec(machine, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.swap.max; echo $WSP_TOKEN; hostname; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done");
    expect(seen.exitCode).toBe(0);
    const lines = seen.stdout.split("\n");
    expect(lines.slice(0, 5)).toEqual(["1073741824", `${givenCpu * 100_000} 100000`, "0", "t", `wsp-${key}`]);
    expect(seen.stdout).toContain("exec sleep infinity");
    const again = await backend.create({ kind: "sandbox", idempotencyKey: key });
    expect(again.id).toBe(machine.id);
    expect(again.replayed).toBe(true);
    expect(await machine.describe!()).toMatchObject({ cpu: givenCpu, memMb: 1024 });
  }, 120_000);

  it("leaves the box a core and a gigabyte whatever the fork asked for, and says so on the handle", async () => {
    const capacity = await backend.capacity();
    const machine = await create({ kind: "sandbox", cpu: 512, memMb: 9_000_000 });
    expect(await machine.describe!()).toMatchObject({ cpu: Math.max(1, capacity.cores - 1), memMb: capacity.machineMemMb });
    expect((await exec(machine, "cat /sys/fs/cgroup/memory.max")).stdout.trim()).toBe(String(capacity.machineMemMb * 1024 * 1024));
    expect(machine.notice).toMatch(/cpu clamped to .* and memory clamped to /);
    // The room the doctor reads back counts this fork at the size the box gave it.
    const after = await backend.capacity();
    expect(after.cpuTaken! - capacity.cpuTaken!).toBe(Math.max(1, capacity.cores - 1));
    expect(after.memTakenMb! - capacity.memTakenMb!).toBe(capacity.machineMemMb);
  }, 60_000);

  it("answers exec with stdout, stderr and the exit code", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(await exec(machine, "echo out; echo err >&2; echo $HOME; exit 7")).toEqual({ exitCode: 7, stdout: "out\n/root\n", stderr: "err\n" });
    const rounds = 20;
    const started = Date.now();
    for (let i = 0; i < rounds; i++) await exec(machine, "true");
    times["exec round trip"] = (Date.now() - started) / rounds;
    expect((await machine.exec("sleep 30; echo late", { timeoutMs: 300 })).exitCode).toBe(124);
  }, 60_000);

  it("answers how long the workspace has been quiet, which is what this host reads before it stops one", async () => {
    const machine = await create({ kind: "sandbox", memMb: 512 });
    // A command run in it is the workspace doing something, so the figure starts over at it and grows from there.
    expect((await exec(machine, "echo working")).stdout).toBe("working\n");
    const quiet = () => backend.lifecycle!.quietForMs!(machine);
    expect(await quiet()).toBeLessThan(1_000);
    await new Promise(r => setTimeout(r, 2_500));
    const grown = await quiet();
    times["quiet figure after 2.5 s of nothing"] = grown!;
    expect(grown).toBeGreaterThan(2_000);
    // And nothing at all once it is stopped: a workspace that is not running has nothing to be quiet about.
    await machine.pause();
    expect(await quiet()).toBeUndefined();
    await machine.resume();
    expect(await quiet()).toBeLessThan(1_000);
  }, 60_000);

  it("takes a project of the computer's own in as a copy, at the path that project has outside", async () => {
    const from = join(ownDir("wsp-runtime-checkout-"), "checkout");
    const at = "/Users/zingzy/wsp";
    execFileSync("mkdir", ["-p", join(from, "src")]);
    writeFileSync(join(from, "README.md"), "the checkout\n");
    writeFileSync(join(from, "src/index.js"), "module.exports = 1\n");
    const machine = await create({ kind: "sandbox", copy: { from, at } });
    // The project is inside at its own path, and what the checkout holds is what the workspace reads there.
    const seen = await exec(machine, `cat ${at}/README.md; cat ${at}/src/index.js`);
    expect(seen.stdout).toBe("the checkout\nmodule.exports = 1\n");
    // Written inside, and the checkout on the computer is not the workspace's to change.
    expect((await exec(machine, `echo inside >> ${at}/README.md`)).exitCode).toBe(0);
    expect(readFileSync(join(from, "README.md"), "utf8")).toBe("the checkout\n");
    expect(existsSync(join(root, "copies", machine.id))).toBe(true);
    await machine.kill();
    made.splice(made.indexOf(machine), 1);
    expect(existsSync(join(root, "copies", machine.id))).toBe(false);
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(join(root, "run", machine.id));
  }, 120_000);

  it("kills by removing the container it was given, and nothing of it stays on the box", async () => {
    const machine = await create({ kind: "sandbox" });
    const id = machine.id;
    await machine.kill();
    made.splice(made.indexOf(machine), 1);
    await expect(machine.state()).rejects.toMatchObject({ kind: "missing", status: 404 });
    expect(existsSync(cgroupOf(id))).toBe(false);
    expect(existsSync(join(root, "run", id))).toBe(false);
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(join(root, "run", id));
  }, 60_000);

  it("maps every container state, and a container the daemon lost is gone", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(await machine.state()).toBe("running");
    await machine.pause();
    expect(await machine.state()).toBe("paused");
    await machine.resume();
    expect(await machine.state()).toBe("running");
    await expect(backend.get("wsp-nobody")).rejects.toMatchObject({ kind: "missing", status: 404, message: "no such workspace: wsp-nobody" });
  }, 60_000);

  it("lists by our labels and answers the size the listing carries", async () => {
    const machine = await create({ kind: "sandbox", cpu: 2, memMb: 1024, labels: { row: "listed" } });
    expect(await backend.list({ row: "listed" })).toEqual([{ id: machine.id, state: "running", labels: { wsp: "1", [OWNER_LABEL]: LIVE_OWNER, row: "listed" }, size: { cpu: 2, memMb: 1024 } }]);
  }, 60_000);

  it("puts bytes where they belong, in parts, and lands the whole file", async () => {
    const machine = await create({ kind: "sandbox" });
    const bytes = randomBytes(5 * 1024 * 1024);
    await machine.putBytes!("/root/wsp daemon/bundle.tgz", bytes);
    const seen = await exec(machine, "sha256sum '/root/wsp daemon/bundle.tgz' | cut -d' ' -f1");
    expect(seen.stdout.trim()).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readdirSync(join(root, "put")).length).toBe(0);
  }, 60_000);

  it("serves no signed URL and says where the bytes go instead", async () => {
    const machine = await create({ kind: "sandbox" });
    await expect(machine.uploadUrl("/root/x")).rejects.toThrow(/no signed upload URL/);
    await expect(machine.downloadUrl("/root/x")).rejects.toThrow(/no signed download URL/);
  }, 60_000);

  it("asks the guest itself whether the daemon is listening, on the road every other call to it takes", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(await machine.daemonAnswers!({ timeoutMs: 5_000 })).toBe(false);
    // The base image carries perl and nothing else that listens; the listener sits on the guest's own loopback.
    const listen = await exec(machine, "nohup perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"127.0.0.1\", LocalPort => 7070, Listen => 5, ReuseAddr => 1) or die $!; sleep 60' > /dev/null 2> /tmp/listen.err & sleep 0.5; cat /tmp/listen.err");
    expect(listen).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await machine.daemonAnswers!({ timeoutMs: 5_000 })).toBe(true);
  }, 60_000);

  it("says a container's daemon is the container's own boot, not a service manager", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(machine.daemonSupervisor).toBe("entrypoint");
    expect((await backend.get(machine.id)).daemonSupervisor).toBe("entrypoint");
  }, 60_000);

  it("describes the container from its record", async () => {
    const machine = await create({ kind: "sandbox", cpu: 1, memMb: 768 });
    const shape = await machine.describe!();
    expect(shape).toMatchObject({ cpu: 1, memMb: 768 });
    expect(shape.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  }, 60_000);

  it("answers the daemon road at the published port on the box's loopback", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(await exec(machine, ANSWER_ON_7070)).toMatchObject({ exitCode: 0, stderr: "" });
    const started = Date.now();
    const reach = await machine.previewUrl!(7070);
    times["previewUrl"] = Date.now() - started;
    // The route the far side published, on its own loopback: the forward is what turns it into one here, and here
    // the forward is the identity since this test runs on the box.
    expect(reach.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(reach.token).toBe("");
    const port = Number(new URL(reach.url).port);
    expect(await readLine(port)).toBe("hello from inside");
    expect((await machine.previewUrl!(7070)).url).toBe(reach.url);
  }, 60_000);

  it("carries a daemon deployed onto a workspace back through the forward, and connectDaemon reads its hello", async () => {
    const machine = await create({ kind: "sandbox", cpu: 2, memMb: 2048 });
    // The deploy itself needs nothing installed now that the daemon is one static binary; what a bare image lacks
    // for the turns after it comes in over the workspace's own outbound road.
    const started = Date.now();
    const apt = await machine.exec(
      "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq > /tmp/apt.log 2>&1 && apt-get install -y -qq curl ca-certificates python3 make g++ >> /tmp/apt.log 2>&1; echo apt $?; tail -c 300 /tmp/apt.log",
      { timeoutMs: 600_000 },
    );
    expect(apt.stdout, apt.stdout).toContain("apt 0");
    times["apt install curl ca-certificates python3 make g++"] = Date.now() - started;
    const deploying = Date.now();
    const { token } = await deployDaemon(machine, { token: randomBytes(24).toString("hex") });
    times["deployDaemon"] = Date.now() - deploying;
    expect(await machine.daemonAnswers!({ timeoutMs: 10_000 })).toBe(true);
    const reach = await machine.previewUrl!(7070);
    const events: DaemonEvent[] = [];
    const link = connectDaemon({ previewUrl: reach.url, token, onEvent: e => events.push(e) });
    try {
      await link.ready;
      expect(events.find(e => e.type === "daemon.hello")).toMatchObject({ type: "daemon.hello" });
      expect((events.find(e => e.type === "daemon.hello") as { root: string }).root).toMatch(/^\//);
    } finally {
      link.close();
    }
  }, 900_000);

  it("keeps no image: a create that names one is refused in one sentence, and the snapshot calls are not there", async () => {
    expect(backend.capabilities.images).toBe(false);
    expect(backend.capabilities.diskSnapshots).toBe(false);
    expect(backend.capabilities.templates).toBe(false);
    expect(backend.capabilities.snapshotListing).toBe(false);
    expect(backend.baseTemplates).toBeUndefined();
    for (const call of ["listSnapshots", "promoteSnapshot", "getTemplate", "listTemplates", "deleteTemplate"]) {
      expect(call in backend, call).toBe(false);
    }
    await expect(backend.create({ kind: "sandbox", template: "ubuntu:24.04" })).rejects.toThrow(NO_IMAGES_HERE);
    await expect(backend.create({ kind: "sandbox", fromSnapshot: "sha256:aa" })).rejects.toThrow(NO_IMAGES_HERE);
    // The two calls the interfaces require answer the same sentence without a frame leaving this computer.
    const machine = await create({ kind: "sandbox" });
    await expect(machine.snapshot("v1", { firstLife: true })).rejects.toThrow(NO_IMAGES_HERE);
    await expect(backend.deleteSnapshot("sha256:aa")).rejects.toThrow(NO_IMAGES_HERE);
  }, 120_000);

  it("takes a workspace of the computer itself: the box's own tools inside, and a wsp folder of its own", async () => {
    const machine = await create({ kind: "sandbox" });
    // The box's own /usr and /etc, read through the workspace's own overlay; its own wsp folder and the
    // engine's data empty inside, whatever the computer holds at either path.
    const seen = await exec(machine, `command -v sh; head -1 /etc/os-release; find ${GUEST_WSP_HOME} /var/lib/docker -mindepth 1 | wc -l`);
    expect(seen.exitCode).toBe(0);
    const onTheBox = readFileSync("/etc/os-release", "utf8").split("\n")[0]!;
    expect(seen.stdout).toContain(onTheBox);
    expect(seen.stdout.trimEnd().split("\n").at(-1)).toBe("0");
    // The binaries the computer itself carries, at the paths it answers with: read off the box here and asked of
    // the workspace, so what this case expects is whatever this box happens to hold and never a path written down.
    const tools = new Map<string, string>();
    for (const tool of ["sh", "env", "git", "node"]) {
      const found = execFileSync("/bin/sh", ["-c", `command -v ${tool} || true`]).toString().trim();
      if (found !== "") tools.set(tool, found);
    }
    expect([...tools.keys()]).toContain("sh");
    const answered = await exec(machine, [...tools.keys()].map(tool => `command -v ${tool}`).join("; "));
    expect(answered.stdout.trimEnd().split("\n")).toEqual([...tools.values()]);
    // A second workspace of the same computer while the first is up, each with its own view of it.
    const second = await create({ kind: "sandbox" });
    expect((await exec(second, "hostname")).stdout.trim()).toBe(second.id);
    expect(await exec(second, "echo mine > /usr/local/lib/second-probe")).toMatchObject({ exitCode: 0 });
    expect(await exec(machine, "cat /usr/local/lib/second-probe")).toMatchObject({ exitCode: 1 });
    expect(existsSync("/usr/local/lib/second-probe")).toBe(false);
    // And the daemon's own token: each workspace writes one at the path the daemon reads by default and reads
    // its own back, where a folder shared with the computer would have the second rewriting the first.
    const held = existsSync(DAEMON_TOKEN_PATH) ? readFileSync(DAEMON_TOKEN_PATH, "utf8") : undefined;
    for (const [w, word] of [[machine, "first"], [second, "second"]] as const) {
      expect(await exec(w, `printf '%s' token-of-the-${word} > ${DAEMON_TOKEN_PATH}`)).toMatchObject({ exitCode: 0 });
    }
    for (const [w, word] of [[machine, "first"], [second, "second"]] as const) {
      expect((await exec(w, `cat ${DAEMON_TOKEN_PATH}`)).stdout).toBe(`token-of-the-${word}`);
      expect(readFileSync(join(root, "run", w.id, "wsp-home/daemon-token"), "utf8")).toBe(`token-of-the-${word}`);
    }
    expect(existsSync(DAEMON_TOKEN_PATH) ? readFileSync(DAEMON_TOKEN_PATH, "utf8") : undefined).toBe(held);
  }, 180_000);

  it("naps by stopping, and the wake boots the saved layer with the same id, address and forward, under 200 ms", async () => {
    const machine = await create({ kind: "sandbox", memMb: 512 });
    expect(await exec(machine, ANSWER_ON_7070)).toMatchObject({ exitCode: 0, stderr: "" });
    const reach = await machine.previewUrl!(7070);
    const port = Number(new URL(reach.url).port);
    expect(await readLine(port)).toBe("hello from inside");
    expect(await exec(machine, "echo kept > /var/tmp/saved; hostname -I")).toMatchObject({ exitCode: 0 });
    const address = (await exec(machine, "hostname -I")).stdout.trim();
    const roomBefore = (await backend.capacity()).memRoomMb;
    await machine.pause();
    expect(await machine.state()).toBe("paused");
    expect(existsSync(cgroupOf(machine.id))).toBe(false);
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(join(root, "run", machine.id));
    await expect(readLine(port)).rejects.toThrow(/ECONNREFUSED/);
    const capacity = await backend.capacity();
    expect(capacity.machines.paused).toBe(1);
    // Other cases' workspaces still run and may hold the whole share; the stopped one at least gives its cap back.
    expect(capacity.memRoomMb).toBeGreaterThanOrEqual(roomBefore);
    expect((await backend.list({ [OWNER_LABEL]: LIVE_OWNER })).find(row => row.id === machine.id)?.state).toBe("paused");
    await expect(exec(machine, "true")).rejects.toThrow(/is stopped/);
    const started = Date.now();
    await machine.resume();
    times["wake from the saved layer"] = Date.now() - started;
    expect(await machine.state()).toBe("running");
    expect(times["wake from the saved layer"]).toBeLessThan(200);
    expect(await exec(machine, "cat /var/tmp/saved; hostname -I")).toMatchObject({ exitCode: 0, stdout: `kept\n${address} \n` });
    expect(existsSync(join(root, "run", machine.id, "upper/var/tmp/saved"))).toBe(true);
    expect((await machine.previewUrl!(7070)).url).toBe(reach.url);
    expect(await exec(machine, ANSWER_ON_7070)).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await readLine(port)).toBe("hello from inside");
  }, 120_000);

  it("a workspace made with engine gets the box's engine through a fenced socket that sees its own containers alone, and one made without has no socket", async () => {
    // Where the box has no engine the daemon refuses the create, which is the other half of this case, and there
    // is nothing to run the socket against.
    const docker = ["/usr/bin/docker", "/usr/local/bin/docker"].find(p => existsSync(p));
    if (docker === undefined) {
      console.log("no container engine on this box; the engine case stands aside");
      await expect(create({ kind: "sandbox", engine: true })).rejects.toThrow(/container engine/);
      return;
    }
    const rss = (): number => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${daemon.pid}/status`, "utf8"))?.[1]);
    const before = rss();
    const machine = await create({ kind: "sandbox", engine: true });
    times["daemon VmRSS kB added by an engine workspace, socket served and idle"] = rss() - before;
    // The client is landed through the byte road, which is not the fence's cost: the next reading starts after it.
    await machine.putBytes!("/usr/local/bin/docker", readFileSync(docker), { timeoutMs: 120_000 });
    expect(await exec(machine, "chmod +x /usr/local/bin/docker; mkdir -p /root/demo /root/.wsp; echo /root/demo > /root/.wsp/roots; readlink -f /var/run/docker.sock")).toMatchObject({ exitCode: 0, stdout: "/run/wsp/docker.sock\n" });
    const landed = rss();
    const name = `wsp-live-${process.pid}-inside`;
    expect(await exec(machine, `docker run -d --name ${name} -p 18081:80 nginx:alpine 2>&1`)).toMatchObject({ exitCode: 0 });
    const inside = await exec(machine, "docker ps --format '{{.Names}}'");
    expect(inside.stdout.trim().split("\n")).toEqual([name]);
    // The box lists it under the workspace's label; the workspace's socket lists nothing of the box's.
    expect(execFileSync("docker", ["ps", "--filter", `label=wsp.workspace=${machine.id}`, "--format", "{{.Names}}"]).toString().trim()).toBe(name);
    const answered = await exec(machine, "exec 3<>/dev/tcp/127.0.0.1/18081; printf 'HEAD / HTTP/1.0\\r\\n\\r\\n' >&3; timeout 5 cat <&3");
    expect(answered.stdout).toContain("HTTP/1.1 200 OK");
    const refused = await exec(machine, "docker run --rm -v /:/host alpine true 2>&1");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout).toContain("a bind mount's source must sit under a project folder of this workspace (/root/demo), and / does not");
    times["daemon VmRSS kB added by one container up through the fence, its port joined"] = rss() - landed;
    const plain = await create({ kind: "sandbox" });
    expect((await exec(plain, "ls /var/run/docker.sock /run/wsp 2>&1")).exitCode).not.toBe(0);
    // The kill takes the workspace's containers with it.
    await machine.kill();
    made.splice(made.indexOf(machine), 1);
    expect(execFileSync("docker", ["ps", "-a", "--filter", `label=wsp.workspace=${machine.id}`, "-q"]).toString().trim()).toBe("");
  }, 240_000);

  it("holds a memory cap: 700 MB touched under a 512 MB cap exits 137", async () => {
    const machine = await create({ kind: "sandbox", memMb: 512 });
    const hog = await exec(machine, "perl -e '$x = \"x\" x (700 * 1024 * 1024); print length($x)'");
    expect(hog.exitCode).toBe(137);
    // The hog is the kill, never the workspace's own init: its exec and its init carry the kernel's default score.
    expect(await machine.state()).toBe("running");
    expect((await exec(machine, "cat /sys/fs/cgroup/memory.events")).stdout).toContain("oom_kill 1");
    expect((await exec(machine, "echo alive")).stdout).toBe("alive\n");
  }, 60_000);
});
