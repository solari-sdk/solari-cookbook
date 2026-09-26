// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture provenance: hand-written in the proc(5) layouts. A fake /proc tree is
// built per test so the daemon's real read path runs on darwin, and a daemon
// pointed at it with --proc-root reads its ports, load, processes and pty
// modes off it; the uid comes from the directories' owner, which is whoever
// runs the test.

export interface FakeProc {
  pid: number;
  ppid?: number;
  comm?: string;
  state?: string;
  /** utime and stime in clock ticks. */
  ticks?: [number, number];
  threads?: number;
  /** Clock ticks after boot. */
  starttime?: number;
  /** Resident pages. */
  rss?: number;
  cmdline?: string[];
  cwd?: string;
  socketInodes?: number[];
  /** The foreground process group on the controlling terminal, which the mode probe reads the foreground comm off. */
  tpgid?: number;
  /** What fd 0 points at: the pty slave the mode probe asks stty about. */
  stdin?: string;
}

export const BTIME = 1_757_000_000;
const AT_PAGESZ = 6;

export function auxv(pageSize: number): Buffer {
  const b = Buffer.alloc(48);
  b.writeBigUInt64LE(BigInt(33), 0);
  b.writeBigUInt64LE(BigInt(0x7fff), 8);
  b.writeBigUInt64LE(BigInt(AT_PAGESZ), 16);
  b.writeBigUInt64LE(BigInt(pageSize), 24);
  return b;
}

function statLine(p: FakeProc): string {
  const [utime, stime] = p.ticks ?? [0, 0];
  const head = [p.state ?? "S", p.ppid ?? 0, 1, 1, 0, p.tpgid ?? -1, 4194560, 10, 0, 0, 0, utime, stime, 0, 0, 20, 0, p.threads ?? 1, 0, p.starttime ?? 100, 1_000_000, p.rss ?? 10];
  const tail = new Array(28).fill(0);
  return `${p.pid} (${p.comm ?? `p${p.pid}`}) ${[...head, ...tail].join(" ")}\n`;
}

/** Written beside and renamed over, so a daemon reading on its own clock sees the old text or the new, never half. */
function writeWhole(path: string, text: string): void {
  writeFileSync(`${path}.next`, text);
  renameSync(`${path}.next`, path);
}

/** Replaces a symlink whatever it pointed at before. */
function relink(target: string, path: string): void {
  rmSync(path, { force: true });
  symlinkSync(target, path);
}

export function writeProc(root: string, p: FakeProc): void {
  const dir = join(root, String(p.pid));
  mkdirSync(dir, { recursive: true });
  writeWhole(join(dir, "stat"), statLine(p));
  writeWhole(join(dir, "comm"), `${p.comm ?? `p${p.pid}`}\n`);
  writeFileSync(join(dir, "cmdline"), (p.cmdline ?? [p.comm ?? `p${p.pid}`]).join("\0") + "\0");
  if (p.cwd !== undefined) relink(p.cwd, join(dir, "cwd"));
  if (p.socketInodes) {
    rmSync(join(dir, "fd"), { recursive: true, force: true });
    mkdirSync(join(dir, "fd"), { recursive: true });
    p.socketInodes.forEach((inode, i) => symlinkSync(`socket:[${inode}]`, join(dir, "fd", String(3 + i))));
  }
  if (p.stdin !== undefined) {
    mkdirSync(join(dir, "fd"), { recursive: true });
    relink(p.stdin, join(dir, "fd", "0"));
  }
}

export interface FakeSys {
  load1?: number;
  memTotalKb?: number;
  memAvailableKb?: number;
}

/** The three files the load module reads, in the proc(5) layouts, written whole so a read never sees half. */
export function writeSys(root: string, sys: FakeSys = {}): void {
  writeFileSync(join(root, "stat"), `cpu  1 2 3 4 5 6 7 8 0 0\nbtime ${BTIME}\nprocesses 100\n`);
  writeFileSync(join(root, "loadavg"), `${(sys.load1 ?? 0.5).toFixed(2)} 0.40 0.30 1/100 200\n`);
  writeFileSync(join(root, "meminfo"), `MemTotal:       ${sys.memTotalKb ?? 4_000_000} kB\nMemFree:         100000 kB\nMemAvailable:   ${sys.memAvailableKb ?? 2_000_000} kB\n`);
}

export function fakeProcTree(procs: FakeProc[], pageSize = 4096): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-fake-proc-"));
  writeSys(root);
  mkdirSync(join(root, "self"));
  writeFileSync(join(root, "self", "auxv"), auxv(pageSize));
  mkdirSync(join(root, "net"));
  writeFileSync(join(root, "net", "tcp"), "");
  writeFileSync(join(root, "net", "tcp6"), "");
  for (const p of procs) writeProc(root, p);
  return root;
}

export interface FakeListener {
  port: number;
  /** The process holding the socket; its fake entry is made when the tree has none. Absent leaves the row with no
   * holder anywhere in the tree, which is a listener the daemon can see and cannot name a pid for. */
  pid?: number;
  loopback?: boolean;
}

/** Where the inodes this file mints for listening sockets start, above anything a test writes by hand, so the sweep
 * below never takes a socket some other part of a tree put there. */
const LISTENER_INODE = 100_000;

/** Every fd link this file made for a listening socket that this set no longer names, taken out: a row that names
 * no holder must leave none behind, or the daemon still reads the pid that was there. Run after the new links are
 * in place, so a port that kept its holder is never momentarily holderless under a daemon's own clock. */
function sweepListeners(root: string, held: ReadonlySet<string>): void {
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    const fd = join(root, name, "fd");
    if (!existsSync(fd)) continue;
    for (const entry of readdirSync(fd)) {
      if (Number(entry) >= LISTENER_INODE && !held.has(`${name}/${entry}`)) rmSync(join(fd, entry), { force: true });
    }
  }
}

/** The address column of /proc/net/tcp: each 32-bit word little-endian in hex, so 127.0.0.1 is 0100007F. */
const hexAddress = (loopback: boolean): string => (loopback ? "0100007F" : "00000000");
const hexPort = (port: number): string => port.toString(16).toUpperCase().padStart(4, "0");

/** What is listening on the fake machine, as /proc/net/tcp shows it and as each holder's fd table names it. The
 * daemon's ports road reads both, so a row here is a port.open or a port.close on its next poll. */
export function setListeners(root: string, rows: readonly FakeListener[]): void {
  const lines = ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"];
  const held = new Set<string>();
  rows.forEach((row, i) => {
    const inode = LISTENER_INODE + row.port;
    lines.push(`   ${i}: ${hexAddress(row.loopback === true)}:${hexPort(row.port)} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0`);
    if (row.pid === undefined) return;
    const dir = join(root, String(row.pid));
    if (!existsSync(join(dir, "stat"))) writeProc(root, { pid: row.pid });
    const fd = join(dir, "fd");
    mkdirSync(fd, { recursive: true });
    // Listed, not stat'ed: the link points at a socket: name no file answers, so a read that follows it says absent.
    if (!readdirSync(fd).includes(String(inode))) symlinkSync(`socket:[${inode}]`, join(fd, String(inode)));
    held.add(`${row.pid}/${inode}`);
  });
  writeWhole(join(root, "net", "tcp"), `${lines.join("\n")}\n`);
  sweepListeners(root, held);
}

const uid = process.getuid?.() ?? 0;
export function fakePasswd(): string {
  const path = join(mkdtempSync(join(tmpdir(), "wsp-fake-passwd-")), "passwd");
  writeFileSync(path, `root:x:0:0:root:/root:/bin/bash\ntester:x:${uid}:${uid}::/home/tester:/bin/sh\n`);
  return path;
}

export interface FakeStty {
  /** Put first on PATH, so the daemon's stty is this one. */
  binDir: string;
  /** What the next stty -a prints; written whole, so a probe mid-write reads the old modes or the new, never half. */
  setModes(tokens: string): void;
  /** How many times the daemon ran stty. */
  calls(): number;
}

/** A stty that prints the modes a test wrote instead of asking a terminal, and counts every run. The mode probe
 * reads pty modes with stty -a on the slave from the fake tree's fd 0, so this and the tree are the whole probe. */
export function fakeStty(): FakeStty {
  const dir = mkdtempSync(join(tmpdir(), "wsp-fake-stty-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const modes = join(dir, "modes");
  const count = join(dir, "count");
  writeFileSync(count, "");
  const stty = join(binDir, "stty");
  writeFileSync(stty, `#!/bin/sh\necho run >> '${count}'\ncat '${modes}'\n`);
  chmodSync(stty, 0o755);
  const setModes = (tokens: string): void => {
    writeWhole(modes, `speed 38400 baud; rows 24; columns 80; ${tokens}\n`);
  };
  setModes("icanon echo");
  // The first run of a script just written costs the system's scan of it, near half a second here; a probe on a
  // 50 ms clock would read as missing. Run once now, so the daemon's first probe pays nothing, and count from zero.
  execFileSync(stty, ["-a"]);
  writeFileSync(count, "");
  return { binDir, setModes, calls: () => readCount(count) };
}

function readCount(path: string): number {
  return readFileSync(path, "utf8").split("\n").filter(l => l === "run").length;
}
