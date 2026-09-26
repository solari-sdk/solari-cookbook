// SPDX-License-Identifier: AGPL-3.0-only
//! The security defaults every workspace runs under, copied from the effective OCI config of a live Docker 29
//! container: the capabilities, the seccomp filter, the masked and read-only paths, the sysctls, the namespaces
//! and the pseudo filesystems it mounts. youki applies whatever the bundle names and ships no profile of its own,
//! so this file is where the defaults live. One capability is left out: CAP_MKNOD, since the device cgroup that
//! keeps a made device from reaching the box's disks needs eBPF this daemon does not carry.

use serde_json::Value;

const PROFILE: &str = include_str!("profile.json");

/// Where the workspace's first process, this binary as its reaper, is bound inside the rootfs.
pub const INIT_PATH: &str = "/sbin/wsp-init";

/// The profile as a JSON object to build one workspace's config.json on.
pub fn profile() -> Value {
    serde_json::from_str(PROFILE).expect("the embedded profile is JSON")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_carries_dockers_defaults_without_mknod() {
        let p = profile();
        let caps: Vec<&str> = p["process"]["capabilities"]["bounding"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
        assert_eq!(caps.len(), 13);
        assert!(!caps.contains(&"CAP_MKNOD"));
        assert!(caps.contains(&"CAP_CHOWN") && caps.contains(&"CAP_SETUID") && caps.contains(&"CAP_NET_BIND_SERVICE"));
        assert_eq!(p["process"]["capabilities"]["effective"], p["process"]["capabilities"]["bounding"]);
        assert_eq!(p["linux"]["seccomp"]["defaultAction"], "SCMP_ACT_ERRNO");
        assert_eq!(p["linux"]["seccomp"]["syscalls"].as_array().unwrap().len(), 15);
        assert!(p["linux"]["maskedPaths"].as_array().unwrap().iter().any(|m| m == "/proc/kcore"));
        assert!(p["linux"]["readonlyPaths"].as_array().unwrap().iter().any(|m| m == "/proc/sys"));
        let kinds: Vec<&str> = p["linux"]["namespaces"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
        for kind in ["mount", "network", "uts", "pid", "ipc", "cgroup"] {
            assert!(kinds.contains(&kind), "{kind}");
        }
        assert!(p["mounts"].as_array().unwrap().iter().all(|m| m["type"] != "bind"));
        // An exec loads this filter itself and serves no notify listener, so no rule's action is SCMP_ACT_NOTIFY, the
        // action libcontainer hands a notify fd back for; an exec refuses such a filter.
        assert!(p["linux"]["seccomp"]["syscalls"].as_array().unwrap().iter().all(|rule| rule["action"] != "SCMP_ACT_NOTIFY"));
        assert!(p.get("hostname").is_none() && p["process"].get("args").is_none() && p["process"].get("apparmorProfile").is_none());
    }
}
