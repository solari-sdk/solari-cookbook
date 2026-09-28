// SPDX-License-Identifier: AGPL-3.0-only
//! Where a daemon on a computer the person owns keeps its files, as the protocol's placeDaemonPaths lays them out:
//! everything under one folder of wsp's own beneath the home, so one sweep takes the lot.

use std::path::{Path, PathBuf};

use crate::numbers;

/// Every path the protocol names under a place's home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceDaemonPaths {
    pub wsp: PathBuf,
    pub dir: PathBuf,
    pub bundle: PathBuf,
    pub inbox: PathBuf,
    pub token_path: PathBuf,
    pub port_file: PathBuf,
    pub run_dir: PathBuf,
    pub put_dir: PathBuf,
    pub open_socket: PathBuf,
    pub manifest_path: PathBuf,
    pub profile_file: PathBuf,
    pub unit_dir: PathBuf,
    pub bin_dir: PathBuf,
    pub roots_path: PathBuf,
    pub place_file: PathBuf,
    pub place_key: PathBuf,
    pub place_log: PathBuf,
}

/// The home with its trailing slashes gone, as the protocol strips them before it joins.
fn trimmed(home: &Path) -> PathBuf {
    let text = home.to_string_lossy();
    let cut = text.trim_end_matches('/');
    PathBuf::from(if cut.is_empty() { "/" } else { cut })
}

pub fn place_daemon_paths(home: &Path) -> PlaceDaemonPaths {
    let at = trimmed(home);
    let wsp = at.join(".wsp");
    PlaceDaemonPaths {
        dir: wsp.join("daemon"),
        bundle: wsp.join("daemon.tgz"),
        inbox: wsp.join("inbox"),
        token_path: wsp.join("daemon-token"),
        port_file: wsp.join("daemon.port"),
        run_dir: wsp.join("run"),
        put_dir: wsp.join("put"),
        open_socket: wsp.join("open.sock"),
        manifest_path: wsp.join("manifest.json"),
        profile_file: wsp.join("profile.sh"),
        unit_dir: at.join(".config/systemd/user"),
        bin_dir: at.join(".local/bin"),
        roots_path: wsp.join("roots"),
        place_file: wsp.join("place.json"),
        place_key: wsp.join("place-key.pem"),
        place_log: wsp.join("place.log"),
        wsp,
    }
}

/// What the job that puts the recipe on a computer the person owns keeps there, as the protocol's
/// placeProvisionPaths lays it out: all of it under the one folder wsp already owns on that computer, so a
/// workspace there never sees it and one sweep takes the lot. The two the daemon reads and no more: the folder a
/// leave takes whole, and the list inside it the leave reads first. What the job itself writes under that folder
/// is the host's to name, and a path here that nothing reads is a path nothing holds to the protocol's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceProvisionPaths {
    pub dir: PathBuf,
    /// What wsp put in the agents' homes there and what it left there, so a leave and a later run tell wsp's own
    /// copy from a file the person has since written.
    pub landed: PathBuf,
}

pub fn place_provision_paths(home: &Path) -> PlaceProvisionPaths {
    let dir = place_daemon_paths(home).wsp.join("provision");
    PlaceProvisionPaths { landed: dir.join("landed"), dir }
}

/// The PATH a daemon on a computer that runs workspaces resolves a command through, and the one every script of
/// the recipe job on such a computer exports: the tools PATH with every directory under that computer's home taken
/// out, and nothing of the unit's own PATH, which is the person's login shell's and may name the home too. A
/// workspace there has the computer's home bound in read-write, so a directory under it is a directory a process
/// inside a workspace writes, and a command found through one would run as root outside every namespace. What is
/// left is the computer's own system directories, which a workspace reads through an overlay of its own or a tool
/// root bound in read-only. The protocol's twin is probePath and the contract fixture holds the two to one text.
pub fn probe_path(home: &Path) -> String {
    let at = trimmed(home);
    let at = at.to_string_lossy();
    let under = |dir: &str| dir == at || dir.starts_with(&format!("{at}/"));
    numbers::TOOLS_PATH.split(':').filter(|dir| !dir.is_empty() && !under(dir)).collect::<Vec<_>>().join(":")
}

/// Every path a leave takes off a place, in the order the protocol's placeOwnedPaths names them: the parts first,
/// each for the line it puts in front of a person reading the leave, then wsp's own folder whole, which takes
/// whatever no part above names. The work folder is not here: what the person's threads wrote there is theirs.
pub fn place_owned_paths(home: &Path) -> Vec<PathBuf> {
    let at = place_daemon_paths(home);
    vec![
        at.place_file,
        at.place_key,
        at.place_log,
        at.dir,
        place_provision_paths(home).dir,
        at.bundle,
        at.inbox,
        at.token_path,
        at.roots_path,
        at.profile_file,
        at.open_socket,
        at.run_dir,
        at.port_file,
        at.bin_dir.join("wsp-open"),
        at.bin_dir.join("xdg-open"),
        at.wsp,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probe_path_is_the_tools_path_with_every_directory_under_the_home_taken_out() {
        assert_eq!(
            probe_path(Path::new("/root")),
            "/usr/local/sbin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
        );
        // A trailing slash is the same home, and a home nothing on the list sits under takes nothing off it.
        assert_eq!(probe_path(Path::new("/root/")), probe_path(Path::new("/root")));
        assert_eq!(probe_path(Path::new("/home/maya")), numbers::TOOLS_PATH);
        // A sibling that shares the prefix is not under it.
        assert_eq!(probe_path(Path::new("/roo")), numbers::TOOLS_PATH);
    }

    #[test]
    fn the_paths_are_the_protocols_under_a_home_with_or_without_a_trailing_slash() {
        let at = place_daemon_paths(Path::new("/home/maya/"));
        assert_eq!(at.wsp, PathBuf::from("/home/maya/.wsp"));
        assert_eq!(at.place_file, PathBuf::from("/home/maya/.wsp/place.json"));
        assert_eq!(at.place_key, PathBuf::from("/home/maya/.wsp/place-key.pem"));
        assert_eq!(at.token_path, PathBuf::from("/home/maya/.wsp/daemon-token"));
        assert_eq!(at.roots_path, PathBuf::from("/home/maya/.wsp/roots"));
        assert_eq!(at.unit_dir, PathBuf::from("/home/maya/.config/systemd/user"));
        assert_eq!(at, place_daemon_paths(Path::new("/home/maya")));
    }

    #[test]
    fn the_provision_folder_follows_the_daemons_and_wsps_own_folder_is_last() {
        let owned: Vec<String> = place_owned_paths(Path::new("/h")).iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let at = place_daemon_paths(Path::new("/h"));
        // The exact list and its order are held against the protocol's own by the contract fixture; what is read
        // here is the rule the two rows were added under.
        let after =
            |path: &Path| owned.iter().position(|row| row == &path.to_string_lossy()).unwrap_or_else(|| panic!("{}", path.display()));
        assert_eq!(after(&place_provision_paths(Path::new("/h")).dir), after(&at.dir) + 1);
        assert!(after(&at.bundle) > after(&place_provision_paths(Path::new("/h")).dir));
        // Last, so every part above it is taken and named first and the folder then takes whatever no part names.
        assert_eq!(owned.last().map(String::as_str), Some("/h/.wsp"));
        assert!(owned.iter().all(|row| row.starts_with("/h/")), "{owned:?}");
    }

    #[test]
    fn the_provision_paths_are_the_protocols_under_the_one_folder_wsp_owns_there() {
        let at = place_provision_paths(Path::new("/h/"));
        assert_eq!(at.dir, PathBuf::from("/h/.wsp/provision"));
        assert_eq!(at.landed, PathBuf::from("/h/.wsp/provision/landed"));
        assert_eq!(at, place_provision_paths(Path::new("/h")));
    }
}
