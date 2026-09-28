// SPDX-License-Identifier: AGPL-3.0-only
//! The two readings a machine answers a pane with, one module per kind. The Machine tab's Live rows ride the
//! metrics module and the Processes tab rides the processes module. A machine wsp forks reads the guest's own
//! /proc; this computer reads its own host with ps, df and the platform's counters, because the /proc road reads
//! nothing at all on a Mac and left both panes at pending. A kind with no row here refuses the watch with what the
//! pane prints, so no slot waits on a stream that never comes. Adding a kind is a row here and its two modules,
//! and the words table in the protocol says the same about it for the panes that cannot ask a daemon at all.

use std::path::PathBuf;
use std::sync::Arc;

use wsp_frames::{numbers, words, DaemonErrorCode, WorkspaceKind};

use crate::paths::OpError;
use crate::proc::{ProcFsSource, ProcSource};
use crate::proc_local::{ports_of_pid_road, LocalProcSource};
use crate::sys::{ProcSysSource, SysSource};
use crate::sys_local::HostSysSource;

pub(crate) struct ReadingsOptions {
    /// The folder this daemon resolves paths inside; the guest's disk row is the filesystem under it.
    pub(crate) root: PathBuf,
    /// The folder turns write in, whose volume this computer's disk row reads.
    pub(crate) work_folder: PathBuf,
    /// A directory laid out like /proc, for tests; the real one otherwise.
    pub(crate) proc_root: PathBuf,
    pub(crate) passwd_path: PathBuf,
    /// Which system this daemon runs on, for the one kind whose machines are not all one: a computer somebody
    /// joined is a Mac as often as it is a Linux box.
    pub(crate) platform: &'static str,
}

/// One kind's two modules. Each is built per daemon, since each holds the readings its own deltas run from.
#[derive(Debug)]
pub(crate) struct KindReadings {
    pub(crate) metrics: fn(&ReadingsOptions) -> Arc<dyn SysSource>,
    pub(crate) processes: fn(&ReadingsOptions) -> Arc<dyn ProcSource>,
}

/// What a daemon on a Linux machine reads, whichever way the host reaches it: that machine's own /proc for both.
/// One module under both kinds rather than two alike, since a fork and a machine somebody owns differ in how the
/// host gets to the daemon and not in what the daemon can see of the machine under it.
static PROC_READINGS: KindReadings = KindReadings {
    metrics: |o| Arc::new(ProcSysSource::new(o.root.clone(), o.proc_root.clone())),
    processes: |o| Arc::new(ProcFsSource::new(o.proc_root.clone(), o.passwd_path.clone(), numbers::PROC_CAP)),
};

/// What a daemon reads on a computer that is not a Linux guest: its own host, with ps, df and the platform's own
/// counters, because the /proc road reads nothing at all on a Mac and left both panes at pending.
static HOST_READINGS: KindReadings = KindReadings {
    metrics: |o| Arc::new(HostSysSource::new(o.work_folder.clone())),
    processes: |o| Arc::new(LocalProcSource::new(None, ports_of_pid_road(o.platform), numbers::PROC_CAP)),
};

/// Which modules a kind reads with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Road {
    /// The machine's own /proc.
    Proc,
    /// The host the daemon runs on, with its commands.
    Host,
    /// The one platform switch there is, inside the one kind whose machines differ: a computer the person joined
    /// runs whatever they own. Every other kind knows its own system from its row.
    ByPlatform,
}

/// The kinds a daemon serves these two readings for. A machine over ssh runs the same daemon a fork does, on the
/// same Linux, so it reads the same /proc: the difference between the two is how the host reaches the daemon, not
/// what the daemon can see of its own machine.
const KIND_READINGS: [(WorkspaceKind, Road); 4] = [
    (WorkspaceKind::Cloud, Road::Proc),
    (WorkspaceKind::Ssh, Road::Proc),
    (WorkspaceKind::Local, Road::Host),
    (WorkspaceKind::Place, Road::ByPlatform),
];

fn by_platform(platform: &str) -> &'static KindReadings {
    if platform == "linux" {
        &PROC_READINGS
    } else {
        &HOST_READINGS
    }
}

/// What answers for a machine of this kind on this system, or the refusal a pane prints in the slot: a word that
/// is not a kind, or a kind with no row, both read as the same refusal.
pub(crate) fn readings_for(kind: &str, platform: &str) -> Result<&'static KindReadings, OpError> {
    let known = WorkspaceKind::from_word(kind);
    let road = known.and_then(|kind| KIND_READINGS.iter().find(|(name, _)| *name == kind).map(|(_, road)| *road));
    match road {
        Some(Road::Proc) => Ok(&PROC_READINGS),
        Some(Road::Host) => Ok(&HOST_READINGS),
        Some(Road::ByPlatform) => Ok(by_platform(platform)),
        None => Err(OpError::coded(DaemonErrorCode::Unsupported, words::not_on_this_kind(kind))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_a_module_for_every_kind_whose_machines_carry_a_daemon() {
        for kind in ["cloud", "ssh", "local", "place"] {
            assert!(readings_for(kind, "linux").is_ok(), "{kind}");
            assert!(readings_for(kind, "macos").is_ok(), "{kind}");
        }
    }

    #[test]
    fn refuses_a_kind_with_no_module_in_the_words_the_pane_prints_so_no_pane_waits_on_a_stream_that_never_comes() {
        // Every kind in the enum has a module today, so the guard is proved against a kind that is not one: what it
        // is for is a kind added to the enum without a row here.
        let err = readings_for("plan9", "linux").unwrap_err();
        assert_eq!(err.code, Some(DaemonErrorCode::Unsupported));
        assert!(err.message.starts_with("not on this kind"), "{}", err.message);
        assert_eq!(
            err.message,
            "not on this kind: this daemon serves a plan9 machine, which reads neither its own load nor its own processes"
        );
    }

    #[test]
    fn every_kind_the_wire_names_has_a_row_and_the_words_are_read_as_the_wire_reads_them() {
        for kind in [WorkspaceKind::Cloud, WorkspaceKind::Ssh, WorkspaceKind::Local, WorkspaceKind::Place] {
            assert_eq!(WorkspaceKind::from_word(kind.as_str()), Some(kind));
            assert!(KIND_READINGS.iter().any(|(row, _)| *row == kind), "{kind:?}");
        }
        assert_eq!(WorkspaceKind::from_word("Cloud"), None);
        assert!(readings_for("Cloud", "linux").is_err());
    }

    #[test]
    fn gives_a_machine_over_ssh_the_same_proc_modules_a_fork_gets_since_the_daemon_on_it_is_the_same_daemon() {
        assert!(std::ptr::eq(readings_for("ssh", "linux").unwrap(), readings_for("cloud", "linux").unwrap()));
        assert!(std::ptr::eq(readings_for("ssh", "macos").unwrap(), readings_for("cloud", "linux").unwrap()));
    }

    #[test]
    fn picks_a_places_two_modules_by_the_system_it_is_on_which_is_the_one_platform_switch_there_is() {
        // On Linux a place reads its own /proc, as a fork does; elsewhere it reads its own host with ps and df,
        // which is what answers on a Mac: the /proc road reads nothing there and left both panes at pending.
        assert!(std::ptr::eq(readings_for("place", "linux").unwrap(), readings_for("cloud", "linux").unwrap()));
        assert!(std::ptr::eq(readings_for("place", "macos").unwrap(), readings_for("local", "linux").unwrap()));
        assert!(!std::ptr::eq(readings_for("place", "macos").unwrap(), readings_for("cloud", "linux").unwrap()));
        assert!(std::ptr::eq(readings_for("local", "macos").unwrap(), readings_for("local", "linux").unwrap()));
    }
}
