// SPDX-License-Identifier: AGPL-3.0-only
// Who the kernel takes first on a guest, for memory and for the cpu. The
// daemon goes last for the memory killer and first for the scheduler: a build
// or a test run that outgrows the machine loses its own processes, not the link
// the app and the command line reach the machine by, and a load of six on two
// vCPUs still leaves the daemon its heartbeats (one build on a 4 GB workspace
// took the daemon, and the app offered a rebuild of a machine that was fine,
// 2026-09-06). Every command a turn or a terminal runs starts at the work
// scores, so nothing the daemon spawns inherits its standing.

/** One above the lowest adjustment Linux takes: the daemon is killed last, never exempt, so a daemon that leaks
 * can still be reclaimed and the kernel is never left with nothing to kill. Only a process with CAP_SYS_RESOURCE
 * may write below zero (measured: root without it gets EACCES); the guest daemon runs as root. */
export const DAEMON_OOM_SCORE_ADJ = -999;

/** Work is taken first: half the machine's memory is counted against it on top of what it uses. Any process may
 * raise its own score, so this needs no privilege. */
export const WORK_OOM_SCORE_ADJ = 500;

/** The daemon's nice value: ahead of every default-priority process, so a saturated cpu still turns its heartbeats
 * around. Only root may go below zero (measured: an unprivileged setPriority(-10) is refused). */
export const DAEMON_NICE = -10;

/** The sh line that puts the running shell, and everything it starts, at the work scores: the memory killer's, and
 * the scheduler's default, which a child of the daemon would otherwise inherit (measured). Both writes are quiet
 * where they cannot apply, so a daemon's tests run on macOS and a shell under a plain-priority daemon is a no-op. */
export function workScoreLine(adj = WORK_OOM_SCORE_ADJ): string {
  return `{ echo ${adj} > /proc/self/oom_score_adj; } 2>/dev/null; renice 0 $$ >/dev/null 2>&1`;
}

/** A command as the daemon launches it: behind the work-score line and exec'd into, so the pid stays the command's
 * own and its argv passes through sh untouched. */
export function workArgv(file: string, args: readonly string[]): { file: string; args: string[] } {
  return { file: "/bin/sh", args: ["-c", `${workScoreLine()}; exec "$0" "$@"`, file, ...args] };
}

/** The share of the machine's memory the daemon's cgroup may hold, as a percentage systemd reads. A share rather
 * than a figure because everything the daemon starts sits in that cgroup with it: the cap bounds the daemon and
 * the terminals under it away from the machine's own services, so a runaway build meets the kernel inside the
 * unit instead of taking the guest agent with it. Chosen against the smallest machine wsp forks, 4 GB, where
 * systemd resolved it to 3225 MB and left 806 MB for the provider's agent, sshd and the rest (measured
 * 2026-09-08). The daemon itself no longer counts against that 806 MB, which is the whole point: it used to be
 * accounted inside the agent's own cgroup, and that is where the kernel found it. */
export const DAEMON_MEMORY_MAX_PERCENT = 80;
