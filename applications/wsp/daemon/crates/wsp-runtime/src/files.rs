// SPDX-License-Identifier: AGPL-3.0-only
//! The one writer for every JSON file a daemon owns whole, on every platform a daemon runs on: the runtime's
//! own records on Linux, and the door's process manifest wherever the daemon is.

use std::io;
use std::io::Write;
use std::path::Path;

use serde::Serialize;

/// A file this daemon owns written whole or not at all: the bytes go to a sibling of their own in the file's
/// directory and the rename puts them at the path, so a daemon that dies inside a write leaves the file it had
/// or no file, never half of one, and two tasks writing the same path never rename each other's bytes.
pub fn write_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let text = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut sibling = tempfile::NamedTempFile::new_in(dir)?;
    sibling.write_all(&text)?;
    sibling.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Read;

    use super::*;

    /// A file this daemon owns is whole or it is the file it was: the bytes land in a sibling and the rename
    /// puts them at the path, so a reader holding the file the write replaced reads all of it and nothing
    /// anywhere reads half of either. A daemon that dies inside a write leaves the old file just this way.
    #[test]
    fn a_json_write_lands_whole_or_not_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("points.json");
        write_json(&path, &vec!["/root/.codex/auth.json".to_owned()]).unwrap();
        let before = fs::read(&path).unwrap();
        // The handle a reader took before the write, which under a rewrite of the same file reads the new bytes
        // and under a rename reads the whole of the old ones.
        let mut held = fs::File::open(&path).unwrap();
        write_json(&path, &vec!["/root/.claude/.credentials.json".to_owned()]).unwrap();
        let mut carried = Vec::new();
        held.read_to_end(&mut carried).unwrap();
        assert_eq!(carried, before, "a write went through the file a reader already had open");
        let now: Vec<String> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(now, ["/root/.claude/.credentials.json"]);
        // The sibling goes with the rename: the directory holds the file it held and nothing beside it.
        let left: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(left, ["points.json"]);
    }
}
