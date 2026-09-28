// SPDX-License-Identifier: AGPL-3.0-only
//! The process manifest: what a person started on the machine, recorded so it can be started again after a move,
//! and the restart script that does it, byte for byte the node daemon's.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use wsp_frames::{numbers, shell_quote, ManifestEntry};

use crate::clock;

pub(crate) struct RecordInput {
    pub(crate) cmd: String,
    pub(crate) cwd: String,
    pub(crate) port: Option<u16>,
}

/// The file as both daemons read it: the next id to hand out and the entries in the order first recorded.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    next_id: u64,
    entries: Vec<ManifestEntry>,
}

pub(crate) struct ProcessManifest {
    /// Keyed on the cwd and the cmd; a record under a known key updates its entry where it stands.
    entries: Vec<(String, ManifestEntry)>,
    next_id: u64,
    path: Option<PathBuf>,
    run_dir: String,
    log_dir: String,
}

fn key_of(cwd: &str, cmd: &str) -> String {
    format!("{cwd} {cmd}")
}

impl ProcessManifest {
    /// Reads the file when one is named and present; a file that is there but cannot be read is a refusal to start,
    /// as it is for the node daemon.
    pub(crate) fn load(path: Option<PathBuf>, run_dir: Option<&Path>, log_dir: Option<&Path>) -> io::Result<ProcessManifest> {
        let mut manifest = ProcessManifest {
            entries: Vec::new(),
            next_id: 1,
            path,
            run_dir: run_dir.map_or_else(|| numbers::DEFAULT_RUN_DIR.to_owned(), |p| p.to_string_lossy().into_owned()),
            log_dir: log_dir.map_or_else(|| numbers::DEFAULT_LOG_DIR.to_owned(), |p| p.to_string_lossy().into_owned()),
        };
        let Some(path) = manifest.path.clone() else { return Ok(manifest) };
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(_) => return Ok(manifest),
        };
        let saved: Saved = serde_json::from_str(&raw).map_err(|e| io::Error::other(format!("{}: {e}", path.display())))?;
        manifest.next_id = saved.next_id;
        for entry in saved.entries {
            manifest.entries.push((key_of(&entry.cwd, &entry.cmd), entry));
        }
        Ok(manifest)
    }

    pub(crate) fn record(&mut self, input: RecordInput) -> io::Result<ManifestEntry> {
        let key = key_of(&input.cwd, &input.cmd);
        let existing = self.entries.iter().position(|(k, _)| *k == key);
        let id = match existing {
            Some(i) => self.entries[i].1.id.clone(),
            None => {
                let id = format!("proc_{}", self.next_id);
                self.next_id += 1;
                id
            }
        };
        let entry = ManifestEntry { id, cmd: input.cmd, cwd: input.cwd, port: input.port, recorded_at: clock::iso_millis(clock::now_ms()) };
        match existing {
            Some(i) => self.entries[i].1 = entry.clone(),
            None => self.entries.push((key, entry.clone())),
        }
        self.save()?;
        Ok(entry)
    }

    pub(crate) fn entries(&self) -> Vec<ManifestEntry> {
        self.entries.iter().map(|(_, e)| e.clone()).collect()
    }

    /// Idempotent restart script for after a machine move: a process is skipped when its port already listens
    /// (grepped from /proc/net/tcp, since ss and netstat are not guaranteed in guests) or its pidfile points at a
    /// live pid.
    pub(crate) fn restart_script(&self) -> String {
        let mut lines: Vec<String> = vec![
            "#!/usr/bin/env bash".to_owned(),
            "set -u".to_owned(),
            format!("mkdir -p {} {}", shell_quote(&self.run_dir), shell_quote(&self.log_dir)),
            String::new(),
            "port_listening() {".to_owned(),
            "  grep -qE \":$1 [0-9A-F]+:[0-9A-F]+ 0A \" /proc/net/tcp /proc/net/tcp6 2>/dev/null".to_owned(),
            "}".to_owned(),
            "pid_alive() {".to_owned(),
            "  [ -f \"$1\" ] && kill -0 \"$(cat \"$1\")\" 2>/dev/null".to_owned(),
            "}".to_owned(),
            String::new(),
        ];
        for (_, e) in &self.entries {
            let pidfile = format!("{}/{}.pid", self.run_dir, e.id);
            let log = format!("{}/{}.log", self.log_dir, e.id);
            let port_guard = e.port.map_or_else(String::new, |port| format!("port_listening {} || ", shell_quote(&format!("{port:04X}"))));
            lines.push(format!("# {}: {}", e.id, e.cmd));
            lines.push(format!("if {port_guard}pid_alive {}; then", shell_quote(&pidfile)));
            lines.push(format!("  echo \"skip {} (already running)\"", e.id));
            lines.push("else".to_owned());
            // exec and full redirection: the subshell must release the caller's fds, and $! must be the real process
            // for the pidfile, not a wrapper shell.
            lines.push(format!(
                "  (cd {} && exec nohup bash -c {} </dev/null >>{} 2>&1) &",
                shell_quote(&e.cwd),
                shell_quote(&e.cmd),
                shell_quote(&log)
            ));
            lines.push(format!("  echo $! >{}", shell_quote(&pidfile)));
            lines.push(format!("  echo \"started {}\"", e.id));
            lines.push("fi".to_owned());
            lines.push(String::new());
        }
        lines.join("\n")
    }

    /// A sibling a death leaves beside the manifest is swept by nothing and read by nothing: the next write
    /// names a new one.
    fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let saved = Saved { next_id: self.next_id, entries: self.entries() };
        wsp_runtime::files::write_json(path, &saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::Command;

    fn record(m: &mut ProcessManifest, cmd: &str, cwd: &str, port: Option<u16>) -> ManifestEntry {
        m.record(RecordInput { cmd: cmd.to_owned(), cwd: cwd.to_owned(), port }).unwrap()
    }

    #[test]
    fn records_entries_dedupes_on_cmd_and_cwd_and_persists_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manifest.json");
        let mut m = ProcessManifest::load(Some(path.clone()), None, None).unwrap();
        record(&mut m, "pnpm dev", "/root/app", Some(8080));
        record(&mut m, "node worker.js", "/root/app", None);
        record(&mut m, "pnpm dev", "/root/app", Some(3000));
        assert_eq!(m.entries().len(), 2);
        assert_eq!(m.entries()[0].port, Some(3000));
        assert_eq!(m.entries()[0].id, "proc_1");

        let reloaded = ProcessManifest::load(Some(path.clone()), None, None).unwrap();
        assert_eq!(reloaded.entries().len(), 2);
        assert_eq!(reloaded.entries().iter().map(|e| e.cmd.as_str()).collect::<Vec<_>>(), ["pnpm dev", "node worker.js"]);
        let mut again = reloaded;
        assert_eq!(record(&mut again, "third", "/x", None).id, "proc_3");

        // The file as the node daemon reads and writes it: nextId and entries, pretty printed.
        let saved: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["nextId"], 4);
        assert_eq!(saved["entries"][1]["cmd"], "node worker.js");
        assert!(saved["entries"][1].get("port").is_none());
        assert!(saved["entries"][0]["recordedAt"].as_str().unwrap().ends_with('Z'));
    }

    /// `save` takes the writer's road, which is described once at the writer's own case in the runtime's
    /// `files`. A daemon killed inside its write is not something a case here can stage; the handle held across
    /// the second record stands in for it.
    #[test]
    fn a_manifest_write_lands_whole_or_not_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manifest.json");
        let mut m = ProcessManifest::load(Some(path.clone()), None, None).unwrap();
        record(&mut m, "pnpm dev", "/root/app", Some(8080));
        let first = fs::read(&path).unwrap();
        let mut held = fs::File::open(&path).unwrap();
        record(&mut m, "node worker.js", "/root/app", None);
        let mut carried = Vec::new();
        held.read_to_end(&mut carried).unwrap();
        assert_eq!(carried, first, "a record went through the file a reader already had open");
        assert_eq!(ProcessManifest::load(Some(path), None, None).unwrap().entries().len(), 2);
        let left: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(left, ["manifest.json"]);
    }

    #[test]
    fn a_manifest_file_that_cannot_be_read_refuses_to_load_and_a_missing_one_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ProcessManifest::load(Some(dir.path().join("none.json")), None, None).unwrap().entries().is_empty());
        let bad = dir.path().join("bad.json");
        fs::write(&bad, "{not json").unwrap();
        let err = ProcessManifest::load(Some(bad.clone()), None, None).err().expect("a corrupt manifest is a refusal");
        assert!(err.to_string().contains("bad.json"), "{err}");
    }

    #[test]
    fn generates_a_restart_script_with_a_listen_guard_for_port_entries() {
        let mut m = ProcessManifest::load(None, None, None).unwrap();
        record(&mut m, "pnpm dev", "/root/app", Some(8080));
        let script = m.restart_script();
        assert!(script.contains("port_listening '1F90'"), "{script}");
        assert!(script.contains("\":$1 [0-9A-F]+:[0-9A-F]+ 0A \""), "{script}");
        assert!(script.contains("cd '/root/app'"), "{script}");
        assert!(script.contains("pnpm dev"), "{script}");
        assert!(script.contains("mkdir -p '/root/.wsp/run' '/root/.wsp/logs'"), "{script}");
    }

    #[test]
    fn the_restart_script_is_the_node_daemons_byte_for_byte() {
        let mut m = ProcessManifest::load(None, Some(Path::new("/r un")), Some(Path::new("/logs"))).unwrap();
        let entry = record(&mut m, "echo 'hi' && sleep 1", "/root/it's", Some(5173));
        record(&mut m, "node worker.js", "/root/app", None);
        let expected = "#!/usr/bin/env bash\nset -u\nmkdir -p '/r un' '/logs'\n\nport_listening() {\n  grep -qE \":$1 [0-9A-F]+:[0-9A-F]+ 0A \" /proc/net/tcp /proc/net/tcp6 2>/dev/null\n}\npid_alive() {\n  [ -f \"$1\" ] && kill -0 \"$(cat \"$1\")\" 2>/dev/null\n}\n\n# proc_1: echo 'hi' && sleep 1\nif port_listening '1435' || pid_alive '/r un/proc_1.pid'; then\n  echo \"skip proc_1 (already running)\"\nelse\n  (cd '/root/it'\\''s' && exec nohup bash -c 'echo '\\''hi'\\'' && sleep 1' </dev/null >>'/logs/proc_1.log' 2>&1) &\n  echo $! >'/r un/proc_1.pid'\n  echo \"started proc_1\"\nfi\n\n# proc_2: node worker.js\nif pid_alive '/r un/proc_2.pid'; then\n  echo \"skip proc_2 (already running)\"\nelse\n  (cd '/root/app' && exec nohup bash -c 'node worker.js' </dev/null >>'/logs/proc_2.log' 2>&1) &\n  echo $! >'/r un/proc_2.pid'\n  echo \"started proc_2\"\nfi\n";
        assert_eq!(entry.id, "proc_1");
        assert_eq!(m.restart_script(), expected);
        assert_eq!(ProcessManifest::load(None, None, None).unwrap().restart_script().matches('\n').count(), 10);
    }

    #[test]
    fn the_restart_script_is_idempotent_a_second_run_does_not_double_start() {
        let dir = tempfile::tempdir().unwrap();
        let run_dir = dir.path().join("run");
        let marker = dir.path().join("marker.txt");
        let mut m = ProcessManifest::load(None, Some(&run_dir), Some(&dir.path().join("logs"))).unwrap();
        let entry = record(&mut m, &format!("echo started >> '{}' && sleep 30", marker.display()), dir.path().to_str().unwrap(), None);
        let script = dir.path().join("restart.sh");
        fs::write(&script, m.restart_script()).unwrap();

        let first = Command::new("bash").arg(&script).output().unwrap();
        let second = Command::new("bash").arg(&script).output().unwrap();
        assert!(first.status.success() && second.status.success());
        // The pidfile is written by the script itself, so the second run finds the first one's process alive.
        assert_eq!(String::from_utf8_lossy(&first.stdout), "started proc_1\n");
        assert_eq!(String::from_utf8_lossy(&second.stdout), "skip proc_1 (already running)\n");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        // The nohup'd child writes the marker on its own clock; it is read once it has a line and a moment more, so
        // a second start would have had time to add its own.
        while fs::read_to_string(&marker).map_or(true, |s| s.is_empty()) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        let pid: i32 = fs::read_to_string(run_dir.join(format!("{}.pid", entry.id))).unwrap().trim().parse().unwrap();
        let lines = fs::read_to_string(&marker).unwrap();
        // The pid the script wrote is the one process this test started; it is the one it ends.
        let alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok();
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), nix::sys::signal::Signal::SIGKILL);
        assert_eq!(lines.trim().lines().count(), 1, "{lines}");
        assert!(alive, "the survivor is alive");
    }
}
