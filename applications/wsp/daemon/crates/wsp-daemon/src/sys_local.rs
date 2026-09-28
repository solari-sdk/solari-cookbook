// SPDX-License-Identifier: AGPL-3.0-only
//! This computer's own utilisation, the metrics module of the local kind: disk from one df on the folder turns
//! write in, which reads the same on macOS and on Linux; cpu, load and memory from the road the platform answers
//! honestly on, one module per system below. On Linux that is the host's own /proc; on a Mac the mach counters,
//! getloadavg, and vm_stat for the memory the kernel would hand out without taking it from anything running.

use std::path::{Path, PathBuf};
use std::process::Command;

use wsp_frames::Usage;

use crate::pty::work_argv;
use crate::sys::{CpuTimes, SysReadings, SysSource};

/// df's numbers are in 1024-byte blocks under -k.
const BLOCK: u64 = 1024;

/// One of this computer's small readers, in the C locale: df, ps and vm_stat all print numbers and column headers
/// the parsers here read, and a login's own locale moves all three. Run behind the work-score line like every
/// child of the daemon, so a slow ps is what the kernel takes first, never the daemon.
pub(crate) fn host_command(file: &str, args: &[&str]) -> Command {
    let (sh, argv) = work_argv(file, args);
    let mut command = Command::new(sh);
    command.args(argv).env("LC_ALL", "C").stdin(std::process::Stdio::null());
    command
}

/// The three counts and the capacity df -kP prints for one filesystem: blocks, used, available, then a percentage.
/// Read from the percentage backwards, since a device name or a mount point may hold spaces and the numbers may not.
pub(crate) fn parse_df(text: &str) -> Result<Usage, String> {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    for i in 3..tokens.len() {
        let percent = tokens[i].strip_suffix('%').is_some_and(digits);
        if percent && digits(tokens[i - 1]) && digits(tokens[i - 2]) && digits(tokens[i - 3]) {
            let total: u64 = tokens[i - 3].parse().map_err(|_| "df printed no filesystem line".to_owned())?;
            let used: u64 = tokens[i - 2].parse().map_err(|_| "df printed no filesystem line".to_owned())?;
            return Ok(Usage { used: used * BLOCK, total: total * BLOCK });
        }
    }
    Err("df printed no filesystem line".to_owned())
}

/// What a Mac can hand out without taking it from something running, out of vm_stat: pages that are free, pages
/// read ahead on speculation, and the inactive list, which the kernel reclaims without asking. Purgeable pages are
/// already counted inside those lists and are not added again. This is the reading MemAvailable is on Linux; the
/// kernel's free count alone reads a Mac at rest as nearly full, because it holds everything else for reuse.
/// Only a Mac runs it; every platform's tests pin its arithmetic.
#[cfg_attr(not(target_os = "macos"), cfg(test))]
pub(crate) fn available_from_vm_stat(text: &str) -> Result<u64, String> {
    let page_size: u64 = text
        .split_once("page size of ")
        .and_then(|(_, rest)| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| "vm_stat printed no page size".to_owned())?;
    let pages = |label: &str| -> Result<u64, String> {
        let prefix = format!("Pages {label}:");
        text.lines()
            .find_map(|l| l.strip_prefix(prefix.as_str()))
            .and_then(|rest| rest.trim().trim_end_matches('.').parse().ok())
            .ok_or_else(|| format!("vm_stat printed no {label} pages"))
    };
    Ok((pages("free")? + pages("speculative")? + pages("inactive")?) * page_size)
}

/// The three readings of this computer that the platform answers differently: cpu counters, the one-minute load,
/// and memory. Adding a platform is a row in host_machine and its module.
pub(crate) trait HostMachine: Send + Sync {
    fn cpu(&self) -> Result<CpuTimes, String>;
    fn load1(&self) -> Result<f64, String>;
    fn memory(&self) -> Result<Usage, String>;
}

/// The Linux host reads its own /proc, which is what the guest's road reads too; the two modules differ only in
/// the disk, which here is the volume the work folder is on.
pub(crate) struct LinuxHost;

impl HostMachine for LinuxHost {
    fn cpu(&self) -> Result<CpuTimes, String> {
        crate::sys::parse_proc_stat(&crate::sys::read_named(Path::new("/proc/stat"))?)
    }

    fn load1(&self) -> Result<f64, String> {
        crate::sys::parse_loadavg(&crate::sys::read_named(Path::new("/proc/loadavg"))?)
    }

    fn memory(&self) -> Result<Usage, String> {
        let (total, available) = crate::sys::parse_meminfo(&crate::sys::read_named(Path::new("/proc/meminfo"))?)?;
        Ok(Usage { used: total.saturating_sub(available), total })
    }
}

#[cfg(target_os = "macos")]
mod darwin {
    use super::*;

    pub(crate) struct DarwinHost;

    impl HostMachine for DarwinHost {
        fn cpu(&self) -> Result<CpuTimes, String> {
            let mut info = libc::host_cpu_load_info { cpu_ticks: [0; libc::CPU_STATE_MAX as usize] };
            let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
            // The libc crate points mach_host_self at mach2, which carries no host statistics; this is the one road
            // to the aggregate cpu counters on a Mac.
            #[allow(deprecated)]
            // SAFETY: mach writes at most `count` words into `info`, which is the struct that flavour names.
            let rc = unsafe {
                libc::host_statistics64(
                    libc::mach_host_self(),
                    libc::HOST_CPU_LOAD_INFO,
                    (&mut info as *mut libc::host_cpu_load_info).cast(),
                    &mut count,
                )
            };
            if rc != libc::KERN_SUCCESS {
                return Err(format!("host_statistics64 failed with {rc}"));
            }
            let ticks = info.cpu_ticks;
            Ok(CpuTimes { idle: f64::from(ticks[libc::CPU_STATE_IDLE as usize]), total: ticks.iter().map(|t| f64::from(*t)).sum() })
        }

        fn load1(&self) -> Result<f64, String> {
            let mut loads = [0f64; 3];
            // SAFETY: getloadavg writes up to three doubles into the array it is handed; nix has no wrapper for it.
            let n = unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };
            if n < 1 {
                return Err("getloadavg answered nothing".to_owned());
            }
            Ok(loads[0])
        }

        fn memory(&self) -> Result<Usage, String> {
            let mut total: u64 = 0;
            let mut len = std::mem::size_of::<u64>();
            // SAFETY: hw.memsize is a 64-bit integer and the length handed in is its size; nix has no sysctl on apple.
            let rc =
                unsafe { libc::sysctlbyname(c"hw.memsize".as_ptr(), (&mut total as *mut u64).cast(), &mut len, std::ptr::null_mut(), 0) };
            if rc != 0 {
                return Err("sysctl hw.memsize failed".to_owned());
            }
            let output = host_command("vm_stat", &[]).output().map_err(|e| format!("vm_stat: {e}"))?;
            let available = available_from_vm_stat(&String::from_utf8_lossy(&output.stdout))?;
            Ok(Usage { used: total.saturating_sub(available), total })
        }
    }
}

/// The machine this daemon was built for.
#[cfg(target_os = "macos")]
pub(crate) fn host_machine() -> Box<dyn HostMachine> {
    Box::new(darwin::DarwinHost)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn host_machine() -> Box<dyn HostMachine> {
    Box::new(LinuxHost)
}

/// This computer as its own workspace reads it. The disk is the volume the work folder is on, which is where turns
/// write; the person's home may be another.
pub(crate) struct HostSysSource {
    work_folder: PathBuf,
    machine: Box<dyn HostMachine>,
}

impl HostSysSource {
    pub(crate) fn new(work_folder: PathBuf) -> HostSysSource {
        HostSysSource { work_folder, machine: host_machine() }
    }
}

impl SysSource for HostSysSource {
    fn read(&self) -> Result<SysReadings, String> {
        let folder = self.work_folder.to_string_lossy();
        let df = host_command("df", &["-kP", &folder]).output().map_err(|e| format!("df: {e}"))?;
        Ok(SysReadings {
            cpu: self.machine.cpu()?,
            load1: self.machine.load1()?,
            mem: self.machine.memory()?,
            disk: parse_df(&String::from_utf8_lossy(&df.stdout))?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX_DF: &str =
        "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/root         20554452 13269800   6387484      68% /\n";
    const MAC_DF: &str =
        "Filesystem  1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s1s1    971350180  22461104 105442184    18%    /\n";
    /// A volume mounted under a name with a space in it, which is a Mac's normal state (Macintosh HD).
    const SPACED_DF: &str =
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk4s2   1000000  400000    600000      40% /Volumes/Big Disk\n";
    /// A Mac's vm_stat, whose free count alone reads this machine as 1.5 GB free of 16 GB while nothing is wrong.
    const MAC_VM_STAT: &str = "Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               98304.
Pages active:                            393216.
Pages inactive:                          262144.
Pages speculative:                        32768.
Pages throttled:                              0.
Pages wired down:                        196608.
Pages purgeable:                          16384.
\"Translation faults\":                 123456789.
Pages stored in compressor:               65536.
Pages occupied by compressor:             32768.
";

    #[test]
    fn reads_dfs_counts_off_the_capacity_column_whatever_the_device_or_the_mount_point_is_called() {
        assert_eq!(parse_df(LINUX_DF).unwrap(), Usage { used: 13_269_800 * 1024, total: 20_554_452 * 1024 });
        assert_eq!(parse_df(MAC_DF).unwrap(), Usage { used: 22_461_104 * 1024, total: 971_350_180 * 1024 });
        assert_eq!(parse_df(SPACED_DF).unwrap(), Usage { used: 400_000 * 1024, total: 1_000_000 * 1024 });
        assert_eq!(parse_df("df: /nope: No such file or directory\n").unwrap_err(), "df printed no filesystem line");
    }

    #[test]
    fn counts_a_macs_reclaimable_pages_as_free_so_its_memory_row_reads_what_is_in_use_and_not_what_is_untouched() {
        const PAGE: u64 = 16_384;
        // Free plus speculative plus the inactive list; purgeable is already inside those and is not added twice.
        assert_eq!(available_from_vm_stat(MAC_VM_STAT).unwrap(), (98_304 + 32_768 + 262_144) * PAGE);
        // The kernel's own free count alone would call this Mac 1.5 GB free; the reclaimable pages make it 6.4 GB.
        assert!(available_from_vm_stat(MAC_VM_STAT).unwrap() > 98_304 * PAGE);
        assert_eq!(available_from_vm_stat("Pages free: 1.\n").unwrap_err(), "vm_stat printed no page size");
        assert_eq!(
            available_from_vm_stat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n").unwrap_err(),
            "vm_stat printed no free pages"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn asks_this_platform_for_memory_the_way_it_answers_honestly_the_hosts_own_meminfo_on_linux() {
        // Memory moves between two reads, so the two agree to within a window rather than exactly.
        let read = LinuxHost.memory().unwrap();
        let (total, available) = crate::sys::parse_meminfo(&std::fs::read_to_string("/proc/meminfo").unwrap()).unwrap();
        assert_eq!(read.total, total);
        assert!((read.used as i64 - (total - available) as i64).abs() < 64 * 1024 * 1024);
    }

    #[test]
    fn reads_this_computer_itself_the_memory_of_its_own_platform_the_disk_of_the_folder_it_is_given_a_load() {
        let reading = HostSysSource::new(std::env::current_dir().unwrap()).read().unwrap();
        assert!(reading.mem.total > 0);
        assert!(reading.mem.used > 0);
        assert!(reading.mem.used < reading.mem.total);
        assert!(reading.disk.total > 0);
        assert!(reading.disk.used <= reading.disk.total);
        assert!(reading.load1 >= 0.0);
        assert!(reading.cpu.total > reading.cpu.idle);
        let again = HostSysSource::new(std::env::current_dir().unwrap()).read().unwrap();
        assert!(again.cpu.total >= reading.cpu.total);
    }

    #[test]
    fn a_folder_that_is_not_there_is_refused_in_dfs_words() {
        let err = HostSysSource::new(PathBuf::from("/no/such/folder/anywhere")).read().unwrap_err();
        assert_eq!(err, "df printed no filesystem line");
    }
}
