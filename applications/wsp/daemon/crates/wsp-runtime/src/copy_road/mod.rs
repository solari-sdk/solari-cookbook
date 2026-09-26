// SPDX-License-Identifier: AGPL-3.0-only
//! How a workspace on the computer somebody sits at is made: a copy of the project folder at a path of its own,
//! by whichever road this computer has, then made a clean checkout by two rules. One module per road and one list
//! of them in the order they are tried, so adding a road is its module and its row here. The roads answer whether
//! they can be taken rather than being picked off a filesystem's name, and the reason a road was passed over rides
//! the report, since a person who asked for a directory clone and got a worktree is owed the sentence.

pub mod aside;
pub mod rules;
pub mod worktree;

#[cfg(target_os = "macos")]
pub mod clonefile;

use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;

use wsp_frames::{Carried, CopyAsk, CopyReport, CopyRoadName};

pub use rules::Walked;

/// Whether a road can be taken here, and the sentence when it cannot.
pub enum Availability {
    Yes,
    No(String),
}

/// What a road's copy still needs once it stands, which is the road's own answer and never the picker's reading of
/// which road it is: a copy holding a git directory of its own is fetched and reset to the base by the rules, and
/// reports the branch it lands on; a copy sharing the folder's own git directory is the checkout it will be the
/// moment it is made, takes no fetch (one there would move the person's own refs) and stands detached, so it
/// reports no branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settling {
    OwnRepo,
    Made,
}

/// One way of making a copy of a folder at another path on this computer.
pub trait CopyRoad: Sync {
    fn name(&self) -> CopyRoadName;
    /// Whether this road can make `to` from `from` here: the volume, the free space, the size line.
    fn available(&self, from: &Path, to: &Path, walked: &Walked, size_line_bytes: u64) -> Availability;
    /// Makes `to`; any failure leaves no `to` behind.
    fn make(&self, from: &Path, to: &Path, base: &str) -> io::Result<()>;
    fn remove(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// What the road carried into the copy, for the report and the row.
    fn carried(&self) -> Carried;
    /// What this road's copy still needs once it stands.
    fn settling(&self) -> Settling;
    /// Whether this failure from `make` means the road's own `available` was wrong about this computer rather than
    /// the copy having failed: the picker takes whatever the road left away, keeps the sentence and tries the next
    /// road. False by default, so a road says nothing here unless the kernel can tell it its own reading was off.
    fn misread(&self, _failed: &io::Error) -> bool {
        false
    }
}

/// The roads this platform has, first choice first. A computer that runs workspaces of its own has none: a
/// workspace there is a fork of an image with the project copied into it, which is the runtime's road and not
/// this one.
#[cfg(target_os = "macos")]
pub const ROADS: &[&dyn CopyRoad] = &[&clonefile::Clonefile, &worktree::Worktree];
#[cfg(not(target_os = "macos"))]
pub const ROADS: &[&dyn CopyRoad] = &[];

/// What a computer with no road of its own answers, whichever half of the verb was asked.
pub const NOT_THIS_COMPUTER: &str = "this computer copies through its workspace runtime; wsp-daemon copy serves a Mac";

/// Why a folder that is not a repo is not a project.
pub fn not_a_repo(from: &Path) -> String {
    format!("{} is not a git repository; a project is a repo", from.display())
}

/// Why a path that is already there is not where a copy goes.
pub fn already_there(to: &Path) -> String {
    format!("{} is already there; a copy is made at a path of its own", to.display())
}

/// Why a road named on a line is no road here.
pub fn no_such_road(road: CopyRoadName) -> String {
    format!("{} is not a road this computer has", road.word())
}

/// The road of a name, for a remove that reads the road off the record rather than asking the disk again.
pub fn road_named(name: CopyRoadName) -> Option<&'static dyn CopyRoad> {
    ROADS.iter().copied().find(|road| road.name() == name)
}

/// The copy, end to end, on the roads this computer has.
pub fn make(ask: &CopyAsk) -> Result<CopyReport, String> {
    make_on(ROADS, ask)
}

/// The copy, end to end, on a given list of roads: the folder read once, then each road in turn until one both
/// says it can be taken and takes it, then the rules that road still needs. A road whose call tells it its own
/// reading was wrong is passed over like one that refused outright, and what it left behind goes with it. The
/// first sentence on the way is the report's `fellBack`, so a person who would have had a directory clone and got
/// a worktree reads why. Anything that fails after a copy stands takes that copy with it, so a refusal never
/// leaves a folder that looks like a workspace and is not one. The roads are handed in so the picker's own
/// behaviour is testable without a second volume to mount.
pub fn make_on(roads: &[&dyn CopyRoad], ask: &CopyAsk) -> Result<CopyReport, String> {
    let started = Instant::now();
    let from = Path::new(&ask.from);
    let to = Path::new(&ask.to);
    if roads.is_empty() {
        return Err(NOT_THIS_COMPUTER.to_owned());
    }
    if !rules::is_repo_top(from) {
        return Err(not_a_repo(from));
    }
    if to.exists() {
        return Err(already_there(to));
    }
    sweep_beside(from);
    let walked = rules::walk(from);
    let branch = ask.base.clone().unwrap_or_else(|| rules::default_branch(from));
    // The branch as the folder holds it, else as the remote holds it: a folder cloned with one branch checked out
    // still copies at the branch its remote calls its own HEAD.
    let base = rules::sha_of(from, &branch)
        .or_else(|| rules::sha_of(from, &format!("origin/{branch}")))
        .ok_or_else(|| format!("{} has no {branch} to copy", from.display()))?;
    let mut passed: Vec<String> = Vec::new();
    for road in tried(roads, ask)? {
        if let Availability::No(why) = road.available(from, to, &walked, ask.size_line_bytes) {
            passed.push(why);
            continue;
        }
        if let Err(failed) = road.make(from, to, &base) {
            if !road.misread(&failed) {
                return Err(failed.to_string());
            }
            let _ = road.remove(from, to);
            passed.push(failed.to_string());
            continue;
        }
        return match settle(road, to, &branch, &base, ask) {
            Ok((sha, fetched, left)) => Ok(CopyReport {
                road: road.name(),
                path: ask.to.clone(),
                base: sha,
                branch: match road.settling() {
                    Settling::OwnRepo => branch,
                    Settling::Made => String::new(),
                },
                fetched,
                carried: road.carried(),
                excluded: left.gone,
                skipped: left.skipped,
                bytes: walked.bytes,
                ms: started.elapsed().as_millis() as u64,
                fell_back: passed.first().cloned(),
            }),
            Err(why) => {
                let _ = road.remove(from, to);
                Err(why)
            }
        };
    }
    Err(passed.join("; "))
}

/// The rules on a copy that has just been made: the path-bound directories out so they rebuild here, and then
/// whatever the road says its copy still needs. The fetch runs in the copy's own git directory, so a copy starts
/// level with the remote rather than behind the person's last pull.
fn settle(road: &dyn CopyRoad, to: &Path, branch: &str, base: &str, ask: &CopyAsk) -> Result<(String, bool, rules::Excluded), String> {
    let left = rules::exclude(to, &ask.exclude)?;
    if road.settling() == Settling::Made {
        return Ok((base.to_owned(), false, left));
    }
    // A base the caller named is the base; the fetch only moves a copy that was going to take the folder's own
    // default branch.
    let fetched = if ask.base.is_none() { rules::fetch(to, branch) } else { None };
    let sha = fetched.clone().unwrap_or_else(|| base.to_owned());
    rules::reset_to(to, branch, &sha)?;
    Ok((sha, fetched.is_some(), left))
}

/// The roads this copy may take, in order: the one the caller named alone, or every road there is. A named road
/// that is no road here is refused rather than quietly taken as another.
fn tried<'a>(roads: &'a [&'a dyn CopyRoad], ask: &CopyAsk) -> Result<Vec<&'a dyn CopyRoad>, String> {
    match ask.road {
        None => Ok(roads.to_vec()),
        Some(named) => roads.iter().copied().find(|road| road.name() == named).map(|road| vec![road]).ok_or_else(|| no_such_road(named)),
    }
}

/// Why the folder somebody works in place is never taken away: it is theirs, and the record that named it is all
/// a delete has to drop.
pub const IN_PLACE_STAYS: &str = "a folder worked in place is the person's own; a delete takes its record and nothing on disk";

/// The copy taken away by the road that made it, which is the road the record carries.
pub fn remove(from: &Path, to: &Path, road: CopyRoadName) -> Result<(), String> {
    if road == CopyRoadName::InPlace {
        return Err(IN_PLACE_STAYS.to_owned());
    }
    if ROADS.is_empty() {
        return Err(NOT_THIS_COMPUTER.to_owned());
    }
    let taking = road_named(road).ok_or_else(|| no_such_road(road))?;
    let Some(at) = copy_of(from, to) else {
        return Err(not_a_copy(from, to));
    };
    if std::fs::symlink_metadata(&at).is_ok_and(|m| !m.is_dir()) {
        return Err(not_a_folder(to));
    }
    sweep_beside(from);
    taking.remove(from, &at).map_err(|e| e.to_string())
}

/// Why a link or a file carrying a copy's name is not taken away.
pub fn not_a_folder(to: &Path) -> String {
    format!(
        "{} is not a folder of its own, so nothing was removed; a copy is a folder beside its project, never a link or a file, and --to names that folder",
        to.display()
    )
}

/// Where `to` is when it has the shape every copy of `from` is made at: beside it, under its name with the work's on
/// the end. Its folder joined to its name, so a trailing slash on `to` never reaches a call that would follow a link.
fn copy_of(from: &Path, to: &Path) -> Option<PathBuf> {
    let (Some(name), Some(copy), Some(parent)) = (from.file_name(), to.file_name(), to.parent()) else { return None };
    let (name_str, copy_str) = (name.to_string_lossy(), copy.to_string_lossy());
    let shaped = Some(parent) == from.parent() && copy_str.len() > name_str.len() + 1 && copy_str.starts_with(&format!("{name_str}-"));
    shaped.then(|| parent.join(copy))
}

/// Why a path that is not a copy of the folder is not taken away.
pub fn not_a_copy(from: &Path, to: &Path) -> String {
    let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let beside = from.parent().unwrap_or(from).join(format!("{name}-<work>"));
    format!(
        "{} is not a copy of {}, so nothing was removed; a copy sits beside its project as {}, and --to names that path",
        to.display(),
        from.display(),
        beside.display()
    )
}

/// The removals a stop cut short beside this project, handed to their own process so the verb answers at once.
fn sweep_beside(from: &Path) {
    let project = [from.to_path_buf()];
    for failed in aside::sweep(aside::beside(&project), aside::remove_later) {
        eprintln!("{failed}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rules::repo;

    fn ask(from: &Path, to: &Path) -> CopyAsk {
        CopyAsk {
            from: from.display().to_string(),
            to: to.display().to_string(),
            base: None,
            exclude: vec![".next".to_owned(), "node_modules/.cache".to_owned()],
            size_line_bytes: 20 * 1024 * 1024 * 1024,
            road: None,
        }
    }

    #[test]
    fn a_folder_that_is_not_a_repo_is_not_a_project() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("plain");
        std::fs::create_dir_all(&from).unwrap();
        let to = dir.path().join("plain-other");
        let refused = make(&ask(&from, &to)).unwrap_err();
        if ROADS.is_empty() {
            assert_eq!(refused, NOT_THIS_COMPUTER);
        } else {
            assert!(refused.contains("is not a git repository"), "{refused}");
        }
        assert!(!to.exists());
    }

    /// A road that says it can be taken and then finds it cannot: the reading was wrong, which is the one thing
    /// `misread` is for. Beside the clone road, since the errnos that mean it are that road's own. `failed` is the errno its call answers with and `left` whether the call leaves a partial
    /// destination behind, so the picker's cleanup can be read.
    #[cfg(target_os = "macos")]
    struct Misreading {
        failed: i32,
        left: bool,
    }

    #[cfg(target_os = "macos")]
    impl CopyRoad for Misreading {
        fn name(&self) -> CopyRoadName {
            CopyRoadName::Clonefile
        }
        fn available(&self, _from: &Path, _to: &Path, _walked: &Walked, _size_line_bytes: u64) -> Availability {
            Availability::Yes
        }
        fn make(&self, _from: &Path, to: &Path, _base: &str) -> io::Result<()> {
            if self.left {
                std::fs::create_dir_all(to.join("half"))?;
            }
            Err(io::Error::from_raw_os_error(self.failed))
        }
        fn remove(&self, _from: &Path, to: &Path) -> io::Result<()> {
            match std::fs::remove_dir_all(to) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            }
        }
        fn carried(&self) -> Carried {
            Carried::DepsAndConfig
        }
        fn settling(&self) -> Settling {
            Settling::OwnRepo
        }
        fn misread(&self, failed: &io::Error) -> bool {
            matches!(failed.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EXDEV))
        }
    }

    /// The picker's own behaviour, with the first road's answer handed in: a real volume that answers ENOTSUP from
    /// the call after saying it clones is not something a test can mount, and what matters is what the picker does
    /// when a road tells it that.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_road_that_finds_its_own_reading_wrong_is_passed_over_and_the_next_road_takes_the_copy() {
        for failed in [libc::ENOTSUP, libc::EXDEV] {
            let dir = tempfile::tempdir().unwrap();
            let from = dir.path().join("work");
            repo(&from);
            let to = dir.path().join("work-other");
            let roads: &[&dyn CopyRoad] = &[&Misreading { failed, left: true }, &worktree::Worktree];
            let report = make_on(roads, &ask(&from, &to)).unwrap();
            assert_eq!(report.road, CopyRoadName::Worktree, "errno {failed}");
            assert_eq!(report.carried, Carried::ConfigOnly);
            // The sentence the road failed with is what the report says it fell back from.
            let why = report.fell_back.clone().unwrap();
            assert_eq!(why, io::Error::from_raw_os_error(failed).to_string());
            // What the passed-over road left behind went with it: the worktree stands where it was, not beside it.
            assert!(to.join("README.md").exists() && !to.join("half").exists());
            remove(&from, &to, report.road).unwrap();
        }
    }

    /// Every other errno is a copy that failed: nothing is tried after it and the sentence is the call's own.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_road_whose_copy_simply_failed_ends_the_copy_and_no_later_road_is_asked() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        let roads: &[&dyn CopyRoad] = &[&Misreading { failed: libc::EIO, left: true }, &worktree::Worktree];
        let refused = make_on(roads, &ask(&from, &to)).unwrap_err();
        assert_eq!(refused, io::Error::from_raw_os_error(libc::EIO).to_string());
        // The worktree road was never asked, so nothing of it is there; what the failed road left is its own to
        // clean, which the clonefile road's own call does.
        assert!(!to.join("README.md").exists());
    }

    /// The two errnos the real clonefile road reads as its own misreading, and the ones it does not.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_clone_road_reads_only_the_two_errnos_that_say_this_volume_does_not_clone_directories() {
        for failed in [libc::ENOTSUP, libc::EXDEV] {
            assert!(clonefile::Clonefile.misread(&io::Error::from_raw_os_error(failed)), "errno {failed}");
        }
        for failed in [libc::EIO, libc::ENOSPC, libc::EACCES, libc::EEXIST, libc::ENOENT] {
            assert!(!clonefile::Clonefile.misread(&io::Error::from_raw_os_error(failed)), "errno {failed}");
        }
        // And a road with nothing to say about its own failures says nothing.
        assert!(!worktree::Worktree.misread(&io::Error::from_raw_os_error(libc::ENOTSUP)));
    }

    /// Each road answers what its copy still needs, and the picker reads that answer and never which road it is.
    #[test]
    fn each_road_says_for_itself_whether_its_copy_is_a_repository_of_its_own() {
        assert_eq!(worktree::Worktree.settling(), Settling::Made);
        #[cfg(target_os = "macos")]
        assert_eq!(clonefile::Clonefile.settling(), Settling::OwnRepo);
    }

    #[test]
    fn a_folder_worked_in_place_is_never_removed() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        assert_eq!(remove(&from, &from, CopyRoadName::InPlace).unwrap_err(), IN_PLACE_STAYS);
        assert!(from.join("README.md").exists());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_computer_that_runs_workspaces_of_its_own_has_no_road_here() {
        assert!(ROADS.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        assert_eq!(make(&ask(&from, &to)).unwrap_err(), NOT_THIS_COMPUTER);
        assert_eq!(remove(&from, &to, CopyRoadName::Worktree).unwrap_err(), NOT_THIS_COMPUTER);
        assert!(!to.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_copy_is_a_clean_checkout_of_the_base_with_the_dependencies_carried_and_the_built_directories_gone() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        std::fs::write(from.join(".gitignore"), b"node_modules/\n.next/\n*.local\n").unwrap();
        assert!(rules::git(&from, &["add", ".gitignore"], rules::READ_MS).unwrap().ok());
        assert!(rules::git(&from, &["commit", "--quiet", "-m", "ignore"], rules::WRITE_MS).unwrap().ok());
        let base = rules::sha_of(&from, "HEAD").unwrap();
        std::fs::create_dir_all(from.join("node_modules/.cache")).unwrap();
        std::fs::create_dir_all(from.join(".next/server")).unwrap();
        std::fs::write(from.join("node_modules/dep.js"), b"dep\n").unwrap();
        std::fs::write(from.join(".env.local"), b"KEY=1\n").unwrap();
        std::fs::write(from.join("README.md"), b"half edited\n").unwrap();
        std::fs::write(from.join("scratch.txt"), b"untracked\n").unwrap();
        let to = dir.path().join("work-other");
        let report = make(&ask(&from, &to)).unwrap();
        assert_eq!(report.road, CopyRoadName::Clonefile);
        assert_eq!(report.base, base);
        assert_eq!(report.branch, "main");
        assert!(!report.fetched, "no remote, so no fetch landed");
        assert_eq!(report.carried, Carried::DepsAndConfig);
        assert_eq!(report.excluded, vec![".next".to_owned(), "node_modules/.cache".to_owned()]);
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        assert_eq!(report.fell_back, None);
        assert!(report.bytes > 0);
        assert_eq!(std::fs::read_to_string(to.join("node_modules/dep.js")).unwrap(), "dep\n");
        assert_eq!(std::fs::read_to_string(to.join(".env.local")).unwrap(), "KEY=1\n");
        assert_eq!(std::fs::read_to_string(to.join("README.md")).unwrap(), "one\n");
        assert!(!to.join("scratch.txt").exists());
        assert!(!to.join(".next").exists());
        // The folder it was copied from is untouched: its edit, its untracked file and its built directory stand.
        assert_eq!(std::fs::read_to_string(from.join("README.md")).unwrap(), "half edited\n");
        assert!(from.join("scratch.txt").exists() && from.join(".next/server").exists());
        remove(&from, &to, report.road).unwrap();
        assert!(!to.exists());
    }

    /// A folder whose default branch is checked out in one of its own worktrees: the copy carries the folder's git
    /// directory, worktree records and all, and still lands on that branch, while the folder keeps its worktree.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_copy_lands_on_the_base_branch_that_a_worktree_of_the_folder_holds() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        assert!(rules::git(&from, &["checkout", "--quiet", "-b", "feature"], rules::WRITE_MS).unwrap().ok());
        let held = dir.path().join("held-main");
        assert!(rules::git(&from, &["worktree", "add", "--quiet", &held.to_string_lossy(), "main"], rules::WRITE_MS).unwrap().ok());
        let to = dir.path().join("work-other");
        let report = make(&ask(&from, &to)).unwrap();
        assert_eq!(report.road, CopyRoadName::Clonefile);
        assert_eq!(report.branch, "main");
        assert_eq!(rules::git(&to, &["rev-parse", "--abbrev-ref", "HEAD"], rules::READ_MS).unwrap().out(), "main");
        let listed = rules::git(&from, &["worktree", "list", "--porcelain"], rules::READ_MS).unwrap();
        assert!(listed.out().contains("held-main"), "the folder lost its own worktree: {}", listed.out());
        remove(&from, &to, report.road).unwrap();
    }

    /// A checkout carrying a link where a folder is meant to be: the copy stands, nothing beside the checkout is
    /// removed, and the report names the row the exclusion left standing and why.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_copy_whose_excluded_row_runs_through_a_link_stands_and_the_report_says_which_row_was_left() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let beside = dir.path().join("beside");
        std::fs::create_dir_all(beside.join(".cache")).unwrap();
        std::fs::write(beside.join(".cache/held"), b"outside the copy\n").unwrap();
        std::os::unix::fs::symlink(&beside, from.join("node_modules")).unwrap();
        std::fs::create_dir_all(from.join(".next/server")).unwrap();

        let to = dir.path().join("work-other");
        let report = make(&ask(&from, &to)).unwrap();
        assert_eq!(report.excluded, vec![".next".to_owned()]);
        assert_eq!(report.skipped.len(), 1, "{:?}", report.skipped);
        assert!(report.skipped[0].starts_with("node_modules/.cache: node_modules is a link"), "{:?}", report.skipped);
        // The copy stands, and the folder the link pointed at is as it was.
        assert!(to.join("README.md").exists());
        assert!(beside.join(".cache/held").is_file(), "the copy removed a folder beside the checkout");
        remove(&from, &to, report.road).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_worktree_road_is_taken_when_the_clone_says_no_and_the_report_names_why() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        // A size line under what the folder holds is the reading that sends the picker to the next road.
        let mut asking = ask(&from, &to);
        asking.size_line_bytes = 1;
        let report = make(&asking).unwrap();
        assert_eq!(report.road, CopyRoadName::Worktree);
        assert_eq!(report.carried, Carried::ConfigOnly);
        assert_eq!(report.branch, "", "a worktree stands detached");
        let why = report.fell_back.clone().unwrap();
        assert!(why.contains("a clone above"), "{why}");
        remove(&from, &to, report.road).unwrap();
        assert!(!to.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_road_named_outright_is_the_road_taken_and_a_path_already_there_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        let mut asking = ask(&from, &to);
        asking.road = Some(CopyRoadName::Worktree);
        let report = make(&asking).unwrap();
        assert_eq!(report.road, CopyRoadName::Worktree);
        assert_eq!(report.fell_back, None, "a road that was asked for fell back from nothing");
        // A second copy at the same path is refused and the first one is untouched.
        let refused = make(&asking).unwrap_err();
        assert!(refused.contains("is already there"), "{refused}");
        assert!(to.join("README.md").exists());
        remove(&from, &to, CopyRoadName::Worktree).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_rule_that_fails_after_the_copy_leaves_no_copy_behind() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        let mut asking = ask(&from, &to);
        // A name that climbs out of the copy is refused by the exclusion, which runs on the copy that was made.
        asking.exclude = vec!["../work".to_owned()];
        let refused = make(&asking).unwrap_err();
        assert!(refused.contains("../work"), "{refused}");
        assert!(!to.exists(), "the copy the failed rule ran on is gone");
        assert!(from.join("README.md").exists());
    }
}
