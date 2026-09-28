// SPDX-License-Identifier: AGPL-3.0-only
//! The daemon is last for the kernel's memory killer and ahead of every default-priority process, written on its
//! own pid at start so every road that starts it gives them; a start that may not write one says so and runs on.
//! A process the daemon starts for a workspace gives both back: the workspace's processes inherit its scores, and a
//! memory hog under a cap must be what the killer picks, not the workspace's own init.
//!
//! Both knobs are Linux's: the file the first one is written to is not on a Mac at all, and the second is refused
//! there to everyone who could act on it. So they are set where they exist and nothing is said where they do not.

#[cfg(target_os = "linux")]
use wsp_frames::{numbers, words};

pub(crate) fn apply() {
    #[cfg(target_os = "linux")]
    set(numbers::DAEMON_OOM_SCORE_ADJ, numbers::DAEMON_NICE);
}

/// The kernel's defaults, for the helpers whose children are a workspace's.
pub(crate) fn for_workspace() {
    #[cfg(target_os = "linux")]
    set(0, 0);
}

#[cfg(target_os = "linux")]
fn set(oom_score_adj: i32, nice: i32) {
    if let Err(e) = std::fs::write("/proc/self/oom_score_adj", oom_score_adj.to_string()) {
        eprintln!("{}", words::oom_not_set(&e.to_string()));
    }
    // SAFETY: setpriority takes three plain integers and touches no memory of ours.
    let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS as _, 0, nice) };
    if rc != 0 {
        eprintln!("{}", words::priority_not_set(&std::io::Error::last_os_error().to_string()));
    }
}
