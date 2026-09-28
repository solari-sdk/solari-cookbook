// SPDX-License-Identifier: AGPL-3.0-only
//! What root inside a workspace gets of the box it runs on, in one list each: the capabilities no workspace holds
//! whatever the profile was copied from, how each tree a workspace's rootfs takes from the box is built, what a
//! workspace reads of the box's own /etc, and the few paths left that the workspace's own empty file or folder
//! goes over.
//!
//! A workspace here is made of the box's own directories and its /root is the person's own home, so the rule is an
//! allowlist and not a list of what to hide: /usr and /opt are the box's whole, /etc is a view of what a tool a
//! workspace runs reads, and /var and /srv are the workspace's own with the package trees the only thing the box
//! lends them. The box's password hashes, the keys it answers ssh on, its repository credentials and its services'
//! own state are not inside to read, rather than hidden inside.
//!
//! The bundle reads `TREES` once per boot and builds each tree the way it says, walks `covered` and binds what
//! that names; the profile is held to `DROPPED_CAPS` by a test. Read on every platform the daemon builds for, so
//! every list is held to the same test wherever the suite runs.

/// Never in a workspace's bounding set, whatever the profile is copied from: the three that let a process out of
/// its namespaces or into the box's kernel, and the one that makes a device node. Named here and nowhere else, and
/// the profile is held to this list rather than the other way round.
pub const DROPPED_CAPS: [&str; 4] = ["CAP_SYS_ADMIN", "CAP_SYS_MODULE", "CAP_SYS_BOOT", "CAP_MKNOD"];

/// Every path inside a workspace the box's own directory may not show through, covered with the workspace's own
/// empty one, and whether the box keeps a file or a directory there. Two rows: what a workspace reads under the
/// box's own system directories is `TREES` and `ETC_ALLOWED` below, so the password hashes, the host keys and the
/// engine's own folders are not inside to cover.
///
/// Read off this list and never off the rootfs, and a link met on one of these paths refuses the boot, which is
/// the rule `ROOT_RUN_COVERS` carries and for the same reason. A box root that keeps `.ssh` as a link would
/// otherwise have the cover land on what the link leads to and the keys read inside by name; a box root with no
/// `.ssh` at all would otherwise have no cover, and a workspace making `/root/.ssh/authorized_keys` would be
/// making it on the home the box root shares with it, which is a login into the box as root.
///
/// /home covers every other home on the box: the trees are /usr, /etc, /opt, /var and /srv, so a workspace's
/// /home is the skeleton's own empty directory, and the row is what keeps it empty the day a build binds the box's
/// root or takes /home from the box as the five above are taken. The one thing under it a workspace does read is a
/// shared tool root, Homebrew's prefix today: the boot binds those in after this cover, at their own paths and
/// read-only, so the tools a road installed there answer inside while nobody's home does.
///
/// /root/.ssh is the person's own keys and the box's authorized_keys, under the bind of the person's own home,
/// and a workspace that could write it would let itself back into the box as root.
///
/// `/root/.wsp` is not here: the boot already binds the workspace's own folder over it, so the daemon inside
/// writes its token where no other workspace on the box reads it. The sudo rules are not here either: a turn
/// inside is root in its own namespaces already, so the box's rules grant it nothing, and an empty
/// `/etc/sudoers` is a file sudo reads as granting nobody anything, which breaks every `sudo` a script inside
/// types for no credential kept back.
pub const EMPTY_BINDS: [(&str, bool); 2] = [("/home", false), ("/root/.ssh", false)];

/// How one of the trees a workspace's rootfs takes from the box is built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Built {
    /// The box's own directory whole, as the overlay's lower: what the box has installed is what a workspace runs.
    Whole,
    /// A view of the box's directory holding `ETC_ALLOWED` and nothing else, built fresh at every boot, as the
    /// overlay's lower. What is not on that list is not inside to read.
    Allowed,
    /// The workspace's own, over a view the box lends nothing to: the directories and the links named here made
    /// in that view, and the box's own trees named here overlaid inside it and nothing else of the box's.
    Own { dirs: &'static [(&'static str, u32)], links: &'static [(&'static str, &'static str)], from_box: &'static [&'static str] },
}

/// The directories a workspace's own /var carries, since the box's own is not its lower, with the mode each
/// wants; /var/tmp is the one every distribution keeps writable by anybody.
pub const VAR_DIRS: [(&str, u32); 9] = [
    ("lib", 0o755),
    ("cache", 0o755),
    ("log", 0o755),
    ("tmp", 0o1777),
    ("spool", 0o755),
    ("mail", 0o755),
    ("local", 0o755),
    ("opt", 0o755),
    ("backups", 0o755),
];

/// The two names under /var every distribution keeps as links into the run directory, which inside a workspace is
/// the workspace's own.
pub const VAR_LINKS: [(&str, &str); 2] = [("run", "/run"), ("lock", "/run/lock")];

/// The box's own trees lent inside a workspace's own /var, each an overlay of its own: the package database and
/// the two caches, so apt and dpkg inside read what the box has installed and write their own.
pub const VAR_FROM_BOX: [&str; 3] = ["/var/lib/dpkg", "/var/lib/apt", "/var/cache/apt"];

/// How each tree a workspace's rootfs takes from the box is built, in the order the boot mounts them. One row per
/// tree and the bundle reads this and nothing else, so adding a tree is a row here and its lists above. The five
/// are `OVERLAID`, which a test holds this to.
pub const TREES: [(&str, Built); 5] = [
    ("/usr", Built::Whole),
    ("/etc", Built::Allowed),
    ("/opt", Built::Whole),
    ("/var", Built::Own { dirs: &VAR_DIRS, links: &VAR_LINKS, from_box: &VAR_FROM_BOX }),
    ("/srv", Built::Own { dirs: &[], links: &[], from_box: &[] }),
];

/// What a workspace reads of the box's own /etc, and nothing else is there to read. The rule for a row: a file a
/// tool a workspace runs reads, never a file a service of the box's own reads. An entry is a relative name under
/// /etc, a file, a directory taken whole or a link taken as a link; a name whose last part ends in a star stands
/// for every name in its folder that begins with the rest of it, since a box names those by version.
///
/// Not on it, and so not inside: `apt/auth.conf` and `apt/auth.conf.d`, which are the box's repository
/// credentials; `shadow` and `gshadow`, its password hashes, and `security/opasswd`, the old ones pam keeps
/// beside them, which is why the security rows are named one by one rather than the tree taken whole;
/// `ssh/ssh_host_*` and `ssh/sshd_config`, the keys it answers ssh on; `ssl/private`, `pki/tls/private` and
/// `letsencrypt`, its certificates' keys, which is why the pki rows are its trust and certificate folders rather
/// than the tree; `krb5.keytab`; its cron, systemd, docker, containerd, netplan, NetworkManager, wireguard,
/// openvpn and ipsec configuration. A workspace holding any of them could answer as the box.
pub const ETC_ALLOWED: &[&str] = &[
    "alternatives",
    "apt/apt.conf.d",
    "apt/keyrings",
    "apt/preferences",
    "apt/preferences.d",
    "apt/sources.list",
    "apt/sources.list.d",
    "apt/trusted.gpg",
    "apt/trusted.gpg.d",
    "bash.bashrc",
    "bash_completion",
    "bash_completion.d",
    "ca-certificates",
    "ca-certificates.conf",
    "debian_version",
    "default",
    "dpkg",
    "environment",
    "fonts",
    "gai.conf",
    "gitconfig",
    "group",
    "host.conf",
    "hostname",
    "hosts",
    "inputrc",
    "issue",
    "java-*",
    "krb5.conf",
    "ld.so.cache",
    "ld.so.conf",
    "ld.so.conf.d",
    "legal",
    "locale.alias",
    "locale.gen",
    "localtime",
    "login.defs",
    "lsb-release",
    "machine-id",
    "magic",
    "magic.mime",
    "mailcap",
    "manpath.config",
    "mime.types",
    "mtab",
    "nanorc",
    "nsswitch.conf",
    "os-release",
    "pam.d",
    "papersize",
    "passwd",
    "pip.conf",
    "pki/ca-trust",
    "pki/tls/cert.pem",
    "pki/tls/certs",
    "pki/tls/ct_log_list.cnf",
    "pki/tls/openssl.cnf",
    "profile",
    "profile.d",
    "protocols",
    "python3",
    "python3.*",
    "rpc",
    "security/access.conf",
    "security/capability.conf",
    "security/faillock.conf",
    "security/group.conf",
    "security/limits.conf",
    "security/limits.d",
    "security/namespace.conf",
    "security/namespace.d",
    "security/namespace.init",
    "security/pam_env.conf",
    "security/pwquality.conf",
    "security/pwquality.conf.d",
    "security/sepermit.conf",
    "security/time.conf",
    "services",
    "shells",
    "skel",
    "ssh/ssh_config",
    "ssh/ssh_config.d",
    "ssl/certs",
    "ssl/ct_log_list.cnf",
    "ssl/openssl.cnf",
    "subgid",
    "subuid",
    "sudo.conf",
    "sudoers",
    "sudoers.d",
    "terminfo",
    "timezone",
    "tmux.conf",
    "ucf.conf",
    "vim",
    "wgetrc",
    "xdg",
    "zsh",
];

/// Every path under the box root's own home that a login shell or a root systemd manager of the box's runs by
/// name, with whether the box keeps a file or a directory there. A workspace is root in a home the box root
/// shares with it, so a line it writes into one of these is a line the box root's next login runs outside every
/// workspace: each is the workspace's own copy of the box's file, or its own folder, bound over the box's. A
/// path the box keeps nothing at is covered all the same, so a workspace cannot make it.
///
/// A link met on one of these paths refuses the boot rather than being followed, which a link met on a share's
/// path is not: what is bound over a link's target leaves the name itself a link in a directory the workspace is
/// uid 0 in, which it may unlink and write in its place, and that is the road this list is here to close. A box
/// whose root keeps one of these inside a dotfiles checkout keeps the checkout and puts the file itself at the
/// name, which the refusal says.
///
/// What that costs, said plainly: a folder above one of these names counts too, so a box whose root keeps
/// `.config` as a link into a dotfiles checkout, which is the common layout, refuses every boot until `.config`
/// is a folder of its own with the checkout's files in it. That is a bigger ask than moving one file, and it is
/// the price of the name itself being the thing a login reads. What still boots is a link below `.config` at a
/// folder no cover's path runs through, a linked `.config/codex` say, which a share follows once.
///
/// What this does not close, said plainly: the box root's own `.bashrc` and `.profile` source files in the shared
/// home beyond these names, an nvm or a cargo environment line, a completion file under `.local/share`, and they
/// put `.local/bin` and `bin` on the PATH. A plant in one of those still runs at the box root's next login. What
/// is closed is what the distribution's own skeleton and the tools it ships read by name; the rest is the shared
/// home the map rules as the design of this place.
pub const ROOT_RUN_COVERS: [(&str, bool); 22] = [
    ("/root/.profile", true),
    ("/root/.bash_profile", true),
    ("/root/.bash_login", true),
    ("/root/.bash_logout", true),
    ("/root/.bashrc", true),
    ("/root/.bash_aliases", true),
    ("/root/.zshenv", true),
    ("/root/.zprofile", true),
    ("/root/.zshrc", true),
    ("/root/.zlogin", true),
    ("/root/.zlogout", true),
    ("/root/.pam_environment", true),
    ("/root/.gitconfig", true),
    ("/root/.config/git/config", true),
    ("/root/.bash_completion", true),
    ("/root/.config/bash_completion", true),
    ("/root/.config/fish/config.fish", true),
    ("/root/.config/fish/conf.d", false),
    ("/root/.config/systemd", false),
    ("/root/.local/share/systemd", false),
    ("/root/.config/environment.d", false),
    ("/root/.config/autostart", false),
];

/// One path inside a workspace and what goes over it: the workspace's own empty file where the box keeps a file
/// there, its own empty directory where it keeps a directory, or its own copy of the box's file where a shell of
/// the box's runs what that file holds.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Cover {
    pub at: String,
    pub file: bool,
    /// The workspace's own copy of what the box keeps there, taken at the first boot that finds no copy and kept
    /// across wakes as the uppers are, rather than an empty file or folder made at every boot.
    pub own: bool,
}

/// Every cover the boot binds, read off the two lists and never off the rootfs: a path the box keeps nothing at is
/// covered all the same, since a workspace that could make it there would be making it on the home the box root
/// shares with it, and the walk that opens each of these makes what is missing.
///
/// A link met on a cover's path refuses the boot rather than being followed. Both lists carry that rule: what is
/// bound over a link's target leaves the name itself a link in a folder the workspace is uid 0 in, which it may
/// unlink and write in its place, so the road the cover closes would stay open.
///
/// The cost, said plainly: on a box that keeps nothing at one of these paths, the boot makes the empty file or
/// folder the bind lands on, on the home the box root shares, and nothing takes it off when the workspace goes.
/// They are the mount point and never the content.
pub fn covered() -> Vec<Cover> {
    let mut out: Vec<Cover> = EMPTY_BINDS.iter().map(|(at, file)| Cover { at: (*at).to_owned(), file: *file, own: false }).collect();
    out.extend(ROOT_RUN_COVERS.iter().map(|(at, file)| Cover { at: (*at).to_owned(), file: *file, own: true }));
    // One cover per path, in one order: what the boot mounts is read by a person in a log line and by a test.
    out.sort();
    out.dedup_by(|a, b| a.at == b.at);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_row_of_both_lists_is_covered_whatever_the_box_keeps_there() {
        let covers = covered();
        // The two rows that are not the box root's own startup files. Two, and no more: what the box's own /etc
        // and /var used to show through is not inside to cover.
        let at: Vec<&str> = covers.iter().filter(|c| !c.own).map(|c| c.at.as_str()).collect();
        assert_eq!(at, ["/home", "/root/.ssh"]);
        // A file is covered with a file and a directory with a directory: a bind of one over the other is refused
        // by the kernel, and the row itself is what says which.
        let file_at = |path: &str| covers.iter().find(|c| c.at == path).unwrap().file;
        assert!(!file_at("/home") && !file_at("/root/.ssh") && file_at("/root/.bashrc"));
        // Every row of both lists, nothing read off a rootfs and nothing left out: a box that keeps nothing at one
        // of these paths is a box where a workspace could make it, on the home the box root shares with it.
        assert_eq!(covers.len(), EMPTY_BINDS.len() + ROOT_RUN_COVERS.len());
        for (row, _) in EMPTY_BINDS.iter().chain(ROOT_RUN_COVERS.iter()) {
            assert!(covers.iter().any(|c| c.at == *row), "{row} is not covered");
        }
        // The box's sudo rules are left as they are: a turn inside is root in its own namespaces, so they grant
        // it nothing, and a file sudo reads as granting nobody anything would break every sudo typed inside.
        assert!(!at.iter().any(|path| path.contains("sudoers")), "{at:?}");
        // No path twice, and no row under another: a bind of one would hide the other and which of the two won
        // would be the order they were made in.
        let every: Vec<&str> = covers.iter().map(|c| c.at.as_str()).collect();
        let once: std::collections::BTreeSet<&str> = every.iter().copied().collect();
        assert_eq!(once.len(), every.len());
        for at in &every {
            assert!(!every.iter().any(|other| *other != *at && at.starts_with(&format!("{other}/"))), "{at} sits under another row");
        }
    }

    /// What a workspace reads of the box's own system directories is a list of what it needs: the table says how
    /// each tree is built, and the /etc list holds what a tool inside reads and no file a service of the box's
    /// own reads.
    #[test]
    fn the_trees_say_how_each_is_built_and_the_etc_list_holds_no_credential_of_the_boxs() {
        // One row per tree, the five the doctor holds a daemon root away from, in the boot's own order.
        assert_eq!(TREES.map(|(dir, _)| dir).to_vec(), wsp_frames::numbers::OVERLAID.to_vec());
        let built = |dir: &str| TREES.iter().find(|(at, _)| *at == dir).unwrap().1;
        assert_eq!(built("/usr"), Built::Whole);
        assert_eq!(built("/opt"), Built::Whole);
        assert_eq!(built("/etc"), Built::Allowed);
        assert_eq!(built("/var"), Built::Own { dirs: &VAR_DIRS, links: &VAR_LINKS, from_box: &VAR_FROM_BOX });
        assert_eq!(built("/srv"), Built::Own { dirs: &[], links: &[], from_box: &[] });
        // The workspace's own /var carries the skeleton a distribution expects, with the two names it keeps as
        // links, and the box lends it the package database and the caches and nothing else.
        assert!(VAR_DIRS.iter().any(|(name, mode)| *name == "tmp" && *mode == 0o1777));
        assert!(VAR_LINKS.contains(&("run", "/run")) && VAR_LINKS.contains(&("lock", "/run/lock")));
        assert!(VAR_FROM_BOX.iter().all(|tree| tree.starts_with("/var/")), "{VAR_FROM_BOX:?}");

        // Every entry a relative name under /etc, no two the same, and none of them climbing out of it.
        for entry in ETC_ALLOWED {
            assert!(!entry.starts_with('/') && !entry.split('/').any(|part| part == ".." || part.is_empty()), "{entry}");
        }
        let once: std::collections::BTreeSet<&&str> = ETC_ALLOWED.iter().collect();
        assert_eq!(once.len(), ETC_ALLOWED.len());
        // What a tool inside reads is on it: the package sources, the mounts df and mount read, the certificates
        // and the accounts a shell resolves a name through.
        for named in [
            "apt/sources.list",
            "mtab",
            "passwd",
            "group",
            "ssl/certs",
            "ca-certificates.conf",
            "terminfo",
            "nsswitch.conf",
            "security/limits.conf",
            "security/pam_env.conf",
            "pki/tls/certs",
            "pki/ca-trust",
            "pki/tls/openssl.cnf",
            "pki/tls/ct_log_list.cnf",
            "pki/tls/cert.pem",
        ] {
            assert!(ETC_ALLOWED.contains(&named), "{named} is not on the list");
        }
        // What a service of the box's own reads is not, whole trees and single files alike: the repository
        // credentials the whole apt tree used to carry, the password hashes, the keys and the certificates.
        for kept in [
            "apt",
            "apt/auth.conf",
            "apt/auth.conf.d",
            "shadow",
            "gshadow",
            "ssh",
            "ssh/sshd_config",
            "ssl",
            "ssl/private",
            "letsencrypt",
            "krb5.keytab",
            "cron.d",
            "crontab",
            "systemd",
            "docker",
            "containerd",
            "netplan",
            "NetworkManager",
            "wireguard",
            "openvpn",
            "ipsec.secrets",
            "security",
            "security/opasswd",
            "pki",
            "pki/tls",
            "pki/tls/private",
        ] {
            assert!(!ETC_ALLOWED.contains(&kept), "{kept} is on the list");
        }
        // The two trees whose children are named one by one carry no row that is a folder above a credential in
        // them: a row of the tree itself, or of a folder holding a key, would take the key with it.
        for tree in ["security", "pki"] {
            let rows: Vec<&&str> = ETC_ALLOWED.iter().filter(|row| row.starts_with(&format!("{tree}/"))).collect();
            assert!(!rows.is_empty(), "{tree} has no row");
            assert!(rows.iter().all(|row| !row.ends_with('/')), "{rows:?}");
        }
        // And the covers left are the two the trees do not answer for.
        assert_eq!(EMPTY_BINDS.map(|(at, _)| at), ["/home", "/root/.ssh"]);
    }

    /// What the box root's own login and its systemd run by name is the workspace's own copy or its own folder,
    /// whether the box keeps something there or not: a path the box has nothing at is covered all the same, since
    /// a workspace that could make it there would have the box root run it.
    #[test]
    fn what_the_box_roots_shell_runs_by_name_is_covered_with_the_workspaces_own() {
        let covers = covered();
        let cover = |at: &str| covers.iter().find(|c| c.at == at).unwrap_or_else(|| panic!("{at} is not covered: {covers:?}")).clone();

        // The files a login reads by name: the workspace's own copy of each, which the boot seeds and keeps.
        for at in ["/root/.bashrc", "/root/.bash_aliases", "/root/.profile"] {
            assert_eq!(cover(at), Cover { at: at.to_owned(), file: true, own: true });
        }
        // The folder a root systemd manager reads units from: the workspace's own, and the folder under it that
        // the box keeps a unit in is not reachable through it.
        assert_eq!(cover("/root/.config/systemd"), Cover { at: "/root/.config/systemd".to_owned(), file: false, own: true });
        // And every rc path the box keeps nothing at, covered all the same: what git reads beside .gitconfig,
        // what the completion script sources at an interactive login, and what fish reads beside its own rc.
        for at in [
            "/root/.zshrc",
            "/root/.bash_login",
            "/root/.gitconfig",
            "/root/.config/git/config",
            "/root/.bash_completion",
            "/root/.config/bash_completion",
            "/root/.config/fish/config.fish",
        ] {
            assert_eq!(cover(at), Cover { at: at.to_owned(), file: true, own: true });
        }
        for at in ["/root/.local/share/systemd", "/root/.config/environment.d", "/root/.config/autostart", "/root/.config/fish/conf.d"] {
            assert_eq!(cover(at), Cover { at: at.to_owned(), file: false, own: true });
        }
        // Every row of the list is one cover and no row is under another, since a bind of one would hide the
        // other and which of the two won would be the order they were made in.
        assert_eq!(covers.iter().filter(|c| c.own).count(), ROOT_RUN_COVERS.len());
        for (at, _) in ROOT_RUN_COVERS {
            let under = ROOT_RUN_COVERS.iter().filter(|(other, _)| *other != at && at.starts_with(&format!("{other}/"))).count();
            assert_eq!(under, 0, "{at} sits under another row of the list");
        }
    }

    /// The capabilities are the profile's to carry and this list's to name: a profile copied again from a live
    /// container would bring Docker's own set back, and this is what says which of them a workspace never holds.
    #[test]
    fn the_dropped_capabilities_are_in_no_set_the_profile_names() {
        let profile = crate::profile::profile();
        for set in ["bounding", "effective", "permitted"] {
            let held: Vec<&str> = profile["process"]["capabilities"][set].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
            for dropped in DROPPED_CAPS {
                assert!(!held.contains(&dropped), "{set} carries {dropped}");
            }
        }
        // And the four are named once each, so a reader of the list reads the whole rule.
        let once: std::collections::BTreeSet<&str> = DROPPED_CAPS.iter().copied().collect();
        assert_eq!(once.len(), DROPPED_CAPS.len());
    }
}
