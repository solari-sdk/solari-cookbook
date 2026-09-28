// SPDX-License-Identifier: AGPL-3.0-only
//! The workspace's first process: this binary, bound into the rootfs, runs the boot command and reaps whatever a
//! turn leaves behind, as Docker's init does. Without it every process an exec backgrounded and lost would sit as
//! a zombie under a `sleep` that never waits, each holding a pid against the workspace's cap. Signals sent to it
//! go to the child; the child's exit is its own.

use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

use nix::sys::signal::{kill, sigprocmask, SigSet, SigmaskHow, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;

/// The signals forwarded to the child. Blocked rather than handled: a pid 1 whose disposition is the default has
/// the kernel drop a signal, and a blocked one is queued for the wait below instead.
const FORWARDED: [Signal; 6] = [Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP, Signal::SIGQUIT, Signal::SIGUSR1, Signal::SIGUSR2];

/// Runs `argv` as the one child and answers its exit code; 127 when it could not be started.
pub fn run(argv: &[String]) -> i32 {
    let Some((program, args)) = argv.split_first() else {
        eprintln!("wsp-init: no command to run");
        return 127;
    };
    let mut set = SigSet::empty();
    set.add(Signal::SIGCHLD);
    for signal in FORWARDED {
        set.add(signal);
    }
    if let Err(e) = sigprocmask(SigmaskHow::SIG_BLOCK, Some(&set), None) {
        eprintln!("wsp-init: blocking signals: {e}");
        return 127;
    }
    let child = match spawn_boot(program, args) {
        Ok(child) => Pid::from_raw(child.id() as i32),
        Err(e) => {
            eprintln!("wsp-init: {program}: {e}");
            return 127;
        }
    };
    loop {
        let signal = match set.wait() {
            Ok(signal) => signal,
            Err(nix::Error::EINTR) => continue,
            Err(e) => {
                eprintln!("wsp-init: waiting for a signal: {e}");
                return 127;
            }
        };
        if signal != Signal::SIGCHLD {
            let _ = kill(child, signal);
            continue;
        }
        if let Some(code) = reap(child) {
            return code;
        }
    }
}

/// The boot command as this process's one child, started with no signal blocked at all.
///
/// The mask is emptied in the child itself, between the fork and the exec, because nothing else does it: the
/// standard library inherits the parent's mask into the child on purpose, and says so where it forks. So the
/// boot command of a workspace read `SigBlk 0x14a07` on a box, the very set blocked above, and the SIGTERM a
/// stop sends sat pending and blocked for ever: every pause ran its whole patience and ended on the kill road,
/// even for a workspace with nothing inside but this.
///
/// Nothing in the hook allocates, takes a lock or touches this process's own memory: between a fork and an exec
/// only the calling thread exists, and a hook that waited on anything another thread held would hang the boot.
fn spawn_boot(program: &str, args: &[String]) -> io::Result<Child> {
    let mut command = Command::new(program);
    command.args(args);
    // Safety: the hook is one sigprocmask call, which is async signal safe and takes nothing of this process.
    unsafe {
        command.pre_exec(|| sigprocmask(SigmaskHow::SIG_SETMASK, Some(&SigSet::empty()), None).map_err(io::Error::from));
    }
    command.spawn()
}

/// Reaps every child that has exited; the code of the one that matters, once it is among them.
fn reap(child: Pid) -> Option<i32> {
    loop {
        match waitpid(None, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(pid, code)) if pid == child => return Some(code),
            Ok(WaitStatus::Signaled(pid, signal, _)) if pid == child => return Some(128 + signal as i32),
            Ok(WaitStatus::StillAlive) | Err(_) => return None,
            Ok(_) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// The one thing the stop road needs of the boot command: that it can take a signal at all. The init blocks
    /// the forwarded set for itself, as a pid 1 must, and the child it spawns has to start clear of it, or a
    /// SIGTERM to that child is queued against a mask nothing ever lifts.
    ///
    /// The child reads its own mask after the exec and writes it out, so what this asserts is the mask a real
    /// boot command runs under, not a mask read between the fork and the exec.
    #[test]
    fn the_boot_command_starts_with_no_signal_blocked_however_this_init_blocks_them() {
        // The init's own mask first, as `run` sets it: a spawn that left the mask alone would hand this on.
        let mut blocked = SigSet::empty();
        blocked.add(Signal::SIGCHLD);
        for signal in FORWARDED {
            blocked.add(signal);
        }
        sigprocmask(SigmaskHow::SIG_BLOCK, Some(&blocked), None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let said = dir.path().join("mask");
        let args = vec!["-c".to_owned(), format!("grep '^SigBlk' /proc/self/status > '{}'", said.display())];
        let mut child = spawn_boot("/bin/sh", &args).unwrap();
        let ended = child.wait().unwrap();
        // This thread's own mask back, before any assertion: a test that failed holding it would leave the
        // signals blocked for whatever runs next in this process.
        sigprocmask(SigmaskHow::SIG_UNBLOCK, Some(&blocked), None).unwrap();
        assert!(ended.success(), "{ended:?}");

        let read = fs::read_to_string(&said).unwrap();
        let mask = read.trim().rsplit_once(char::is_whitespace).map(|(_, word)| word).unwrap_or_default();
        assert_eq!(u64::from_str_radix(mask, 16).unwrap(), 0, "the boot command inherited a blocked mask: {read}");
        // And the mask this case set is off this thread again, so nothing else in this process runs behind it.
        assert!(!SigSet::thread_get_mask().unwrap().contains(Signal::SIGTERM), "this thread kept the mask the case set");
    }
}
