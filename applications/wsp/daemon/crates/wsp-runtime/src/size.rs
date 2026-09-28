// SPDX-License-Identifier: AGPL-3.0-only
//! The one size rule of a box: what a computer somebody keeps will give one workspace, out of what the create or
//! the fork asked for. It lives here rather than beside the create because every road into one meets it (the
//! command line, the app, the tool door, a thread forking a sibling) and because a box holding a person's own work
//! must still answer them while a workspace on it is busy. Read on every platform the daemon builds for, so the
//! rule is held to the same test wherever the suite runs.

use std::fs;

/// The least every workspace leaves the box it runs on, whatever size it was asked for: a core and a gigabyte.
pub const BOX_CORE_HEADROOM: f64 = 1.0;
pub const BOX_MEMORY_HEADROOM_MB: u64 = 1024;
/// The most of a box's memory one workspace's cap may name, beside the headroom: a third, since a computer
/// somebody keeps is serving their own work while a workspace runs on it and two more pieces of work may be named
/// on it before this one is done.
pub const BOX_MEMORY_SHARE: f64 = 1.0 / 3.0;
/// The least a workspace's memory cap is ever held down to, named here and nowhere else: an agent and the dev
/// server it starts live above this together, and below it the guest's own daemon does not run at all. A box too
/// small to leave the headroom gives this much rather than nothing.
pub const LEAST_MEM_MB: u64 = 1024;
/// Where the kernel says how much memory the box has.
const MEMINFO: &str = "/proc/meminfo";

/// What the box has, read once at open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxFacts {
    pub cores: u64,
    pub mem_mb: u64,
}

impl BoxFacts {
    pub fn read() -> BoxFacts {
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get() as u64);
        let mem_mb = mem_mb_of(&fs::read_to_string(MEMINFO).unwrap_or_default(), "MemTotal:").unwrap_or(0);
        BoxFacts { cores, mem_mb }
    }

    /// The most one workspace's cpu quota may name here.
    pub fn machine_cpu(&self) -> f64 {
        (self.cores as f64 - BOX_CORE_HEADROOM).max(1.0)
    }

    /// The most one workspace's memory cap may name here: the smaller of the box's share and the box less its
    /// headroom, held up to the floor. At a third the share is what binds on every box big enough to leave the
    /// floor, and the headroom stands as the guard it always was: whatever the share is, a workspace never names
    /// the box's last gigabyte.
    pub fn machine_mem_mb(&self) -> u64 {
        let share = (self.mem_mb as f64 * BOX_MEMORY_SHARE).floor() as u64;
        share.min(self.mem_mb.saturating_sub(BOX_MEMORY_HEADROOM_MB)).max(LEAST_MEM_MB)
    }
}

/// What the box has free this moment, off the kernel's own figure for what may be handed out without pushing it
/// into reclaim. Read at the ask and never kept, since it moves with every process on the box: this is what the
/// room check holds a create to, rather than the sum of the caps the workspaces here were given, so five awake
/// workspaces whose processes are all small still fit. Nothing on a computer whose kernel keeps no such file,
/// where a create is held to nothing.
pub fn free_mem_mb() -> Option<u64> {
    mem_mb_of(&fs::read_to_string(MEMINFO).ok()?, "MemAvailable:")
}

/// One figure off /proc/meminfo, in megabytes: the kernel writes them in kilobytes, one to a line.
fn mem_mb_of(meminfo: &str, key: &str) -> Option<u64> {
    let kb: u64 = meminfo.lines().find_map(|line| line.strip_prefix(key))?.trim().trim_end_matches("kB").trim().parse().ok()?;
    Some(kb / 1024)
}

/// A size as this box gives it: never absent, since a workspace with no cap of its own is a workspace that can
/// take the box, and the sentence naming what was held back where anything was.
#[derive(Debug, Clone, PartialEq)]
pub struct SizeOnBox {
    pub cpu: f64,
    pub mem_mb: u64,
    pub clamped: Option<String>,
}

/// The box's one size rule, which every road into a create or a fork meets here: a workspace takes neither the
/// last core nor the last gigabyte, whatever it asked for, since the box is a computer somebody else is using.
/// A side the spec leaves out takes the box's own ceiling rather than passing through as no cap at all, since a
/// caller that names no size is the one case where nothing else would hold it. What comes back is what the record
/// stores and the cgroup is written with, so every later reader sees the size the box gave rather than the size
/// somebody typed.
pub fn size_on_box(facts: &BoxFacts, cpu: Option<f64>, mem_mb: Option<u64>) -> SizeOnBox {
    let (cpu_cap, mem_cap) = (facts.machine_cpu(), facts.machine_mem_mb());
    let given_cpu = cpu.map_or(cpu_cap, |c| c.min(cpu_cap));
    let given_mem = mem_mb.map_or(mem_cap, |m| m.min(mem_cap));
    let mut cuts = Vec::new();
    if cpu.is_none_or(|c| c > cpu_cap) {
        cuts.push(format!("cpu clamped to {}", number_word(given_cpu)));
    }
    if mem_mb.is_none_or(|m| m > mem_cap) {
        cuts.push(format!("memory clamped to {}", gb_word(given_mem)));
    }
    let clamped = (!cuts.is_empty()).then(|| format!("{} on {}: {}", size_word(cpu, mem_mb), core_word(facts.cores), cuts.join(" and ")));
    SizeOnBox { cpu: given_cpu, mem_mb: given_mem, clamped }
}

/// The size a person typed, as the clamp sentence names it back: `size 2x4` where both were asked for, the one
/// that was where only one is named, and no size at all where the spec named neither.
fn size_word(cpu: Option<f64>, mem_mb: Option<u64>) -> String {
    match (cpu, mem_mb) {
        (Some(cpu), Some(mem_mb)) => format!("size {}x{}", number_word(cpu), number_word(gb_of(mem_mb))),
        (Some(cpu), None) => format!("size {} cpu", number_word(cpu)),
        (None, Some(mem_mb)) => format!("size {}", gb_word(mem_mb)),
        (None, None) => "no size".to_owned(),
    }
}

/// The box's cores as the sentence counts them, with no article in front: every article that reads right before
/// 2 reads wrong before 8, 11, 18 and 80.
fn core_word(cores: u64) -> String {
    format!("{cores} core{}", if cores == 1 { "" } else { "s" })
}

fn gb_of(mem_mb: u64) -> f64 {
    ((mem_mb as f64 / 1024.0) * 10.0).round() / 10.0
}

fn gb_word(mem_mb: u64) -> String {
    format!("{} GB", number_word(gb_of(mem_mb)))
}

/// A size's number as a person writes it: whole where it is whole, since `2` is the size somebody asked for and
/// `2.0` is not a word anybody typed.
fn number_word(n: f64) -> String {
    format!("{n}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The box the size rule is read against: two cores and four gigabytes, the shape the fork that took a whole
    /// box ran on.
    fn small_box() -> BoxFacts {
        BoxFacts { cores: 2, mem_mb: 4096 }
    }

    #[test]
    fn the_box_is_read_off_proc_and_the_size_is_held_to_it() {
        let facts = BoxFacts::read();
        assert!(facts.cores >= 1);
        // The memory comes off the same file the read above opens, which only a box has; on any other computer
        // the read answers nothing and the floor is what the rule gives.
        if std::path::Path::new(MEMINFO).exists() {
            assert!(facts.mem_mb > 0);
        }
        assert!(facts.machine_cpu() >= 1.0 && facts.machine_cpu() <= facts.cores as f64);
        assert!(facts.machine_mem_mb() >= LEAST_MEM_MB && facts.machine_mem_mb() <= facts.mem_mb.max(LEAST_MEM_MB));
    }

    #[test]
    fn a_fork_of_the_whole_box_gets_a_core_and_a_third_of_the_memory_and_the_answer_says_so() {
        let given = size_on_box(&small_box(), Some(2.0), Some(4096));
        assert_eq!((given.cpu, given.mem_mb), (1.0, 1365));
        assert_eq!(given.clamped.as_deref(), Some("size 2x4 on 2 cores: cpu clamped to 1 and memory clamped to 1.3 GB"));
    }

    #[test]
    fn a_fork_that_leaves_the_box_room_is_given_what_it_asked_for_and_the_answer_says_nothing() {
        let given = size_on_box(&small_box(), Some(1.0), Some(1024));
        assert_eq!((given.cpu, given.mem_mb, given.clamped), (1.0, 1024, None));
    }

    #[test]
    fn a_size_the_box_holds_down_on_one_side_alone_names_that_side() {
        let cpu_only = size_on_box(&small_box(), Some(4.0), Some(1024));
        assert_eq!((cpu_only.cpu, cpu_only.mem_mb), (1.0, 1024));
        assert_eq!(cpu_only.clamped.as_deref(), Some("size 4x1 on 2 cores: cpu clamped to 1"));
        // The side the spec leaves out takes the ceiling, so it is named beside the one that was cut.
        let mem_only = size_on_box(&small_box(), None, Some(8192));
        assert_eq!((mem_only.cpu, mem_only.mem_mb), (1.0, 1365));
        assert_eq!(mem_only.clamped.as_deref(), Some("size 8 GB on 2 cores: cpu clamped to 1 and memory clamped to 1.3 GB"));
    }

    #[test]
    fn a_spec_that_names_no_size_takes_the_box_ceiling_rather_than_no_cap_at_all() {
        // Nothing above the daemon fills this in for a client on the link, and a workspace with no cap of its own
        // can hold the whole box however small its size was meant to be.
        let given = size_on_box(&small_box(), None, None);
        assert_eq!((given.cpu, given.mem_mb), (1.0, 1365));
        assert_eq!(given.clamped.as_deref(), Some("no size on 2 cores: cpu clamped to 1 and memory clamped to 1.3 GB"));
    }

    #[test]
    fn the_memory_ceiling_is_a_third_of_the_box_and_the_floor_under_a_box_too_small_for_one() {
        // The box the workspaces on a computer somebody keeps are measured on, which is the one the proof runs on.
        let spoo = size_on_box(&BoxFacts { cores: 2, mem_mb: 7747 }, Some(2.0), Some(7747));
        assert_eq!(spoo.mem_mb, 2582);
        assert_eq!(spoo.clamped.as_deref(), Some("size 2x7.6 on 2 cores: cpu clamped to 1 and memory clamped to 2.5 GB"));
        // A box whose third is under the floor gives the floor, since below it nothing inside runs at all.
        assert_eq!(size_on_box(&BoxFacts { cores: 4, mem_mb: 2048 }, Some(1.0), Some(2048)).mem_mb, LEAST_MEM_MB);
        assert_eq!(size_on_box(&BoxFacts { cores: 8, mem_mb: 8192 }, Some(4.0), Some(8192)).mem_mb, 2730);
        // And whatever the share is, the headroom stands: a box big enough to leave the floor keeps its gigabyte.
        for mem_mb in [2048, 4096, 7747, 8192, 16_384, 65_536] {
            let facts = BoxFacts { cores: 4, mem_mb };
            assert!(facts.machine_mem_mb() <= mem_mb - BOX_MEMORY_HEADROOM_MB, "{mem_mb}");
        }
    }

    #[test]
    fn a_one_core_box_still_gives_a_core_and_a_tiny_box_still_gives_memory() {
        let given = size_on_box(&BoxFacts { cores: 1, mem_mb: 1024 }, Some(2.0), Some(2048));
        assert_eq!((given.cpu, given.mem_mb), (1.0, LEAST_MEM_MB));
        assert_eq!(given.clamped.as_deref(), Some("size 2x2 on 1 core: cpu clamped to 1 and memory clamped to 1 GB"));
    }

    #[test]
    fn the_two_figures_are_read_off_the_kernels_own_file_in_megabytes() {
        let meminfo = "MemTotal:        7932016 kB\nMemFree:          312244 kB\nMemAvailable:    4093852 kB\n";
        assert_eq!(mem_mb_of(meminfo, "MemTotal:"), Some(7746));
        assert_eq!(mem_mb_of(meminfo, "MemAvailable:"), Some(3997));
        assert_eq!(mem_mb_of(meminfo, "SwapTotal:"), None);
        assert_eq!(mem_mb_of("", "MemTotal:"), None);
        assert_eq!(mem_mb_of("MemAvailable:    not a number\n", "MemAvailable:"), None);
        // On a box the free figure answers and sits inside what the box holds; on any other computer there is no
        // such file and a create is held to nothing.
        match free_mem_mb() {
            Some(free) => assert!(free > 0 && free <= BoxFacts::read().mem_mb, "{free}"),
            None => assert!(!std::path::Path::new(MEMINFO).exists()),
        }
    }
}
