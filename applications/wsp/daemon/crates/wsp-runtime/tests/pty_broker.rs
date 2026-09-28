// SPDX-License-Identifier: AGPL-3.0-only
//! The pane's broker run where it runs on a box: as a process of its own. It takes SIGCHLD and SIGWINCH for the
//! whole process, and in the crate's own test binary that took SIGCHLD from tokio's child reaper, whose waits on
//! a Mac are woken by nothing else, so a case waiting on a child there never woke. This binary holds no such wait.

use std::path::PathBuf;

use wsp_runtime::pty::{run, Ask};

/// The broker ends when the shell it put on the slave does. Every copy of that slave this process holds has
/// to go for the master to read its end: the one the pair was opened with, and the three a command keeps for
/// the child's stdio until it is dropped, which is not when it has spawned. With one left open the pump waits
/// on a terminal nothing writes to any more, the helper never ends, and a pane whose shell has exited reads
/// nothing at all.
#[test]
fn the_broker_ends_when_the_shell_on_its_slave_does() {
    let dir = tempfile::tempdir().unwrap();
    let ask = Ask {
        cols: 80,
        rows: 24,
        cwd: PathBuf::from("/"),
        size_file: dir.path().join("pty-1.size"),
        env: vec![("TERM".to_owned(), "xterm-256color".to_owned())],
        argv: vec!["/bin/sh".to_owned(), "-c".to_owned(), "printf 'on the pty\n'; exit 7".to_owned()],
    };
    let (told, ended) = std::sync::mpsc::channel();
    std::thread::spawn(move || told.send(run(&ask)));
    let code = ended
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("the broker ends with the shell on its slave, rather than waiting on a terminal nothing holds");
    assert_eq!(code, 7, "the broker exits with the shell's own code");
}

/// What a person's pane reads in its shell's environment: the entries the daemon named for this terminal,
/// set over what the broker itself was started with, which inside a workspace is that workspace's own. The
/// shell writes them into a file of the case's own rather than onto its terminal, since what the terminal
/// carries goes to this process's stdout.
#[test]
fn the_shell_on_the_pane_takes_the_environment_the_ask_names() {
    let dir = tempfile::tempdir().unwrap();
    let said = dir.path().join("said");
    let ask = Ask {
        cols: 80,
        rows: 24,
        cwd: PathBuf::from("/"),
        size_file: dir.path().join("pty-3.size"),
        env: vec![("WSP_KNOB".to_owned(), "/opt/wsp/uv/tools".to_owned()), ("TERM".to_owned(), "xterm-256color".to_owned())],
        argv: vec!["/bin/sh".to_owned(), "-c".to_owned(), format!("printf '%s %s\\n' \"$WSP_KNOB\" \"$TERM\" > {}", said.display())],
    };
    let (told, ended) = std::sync::mpsc::channel();
    std::thread::spawn(move || told.send(run(&ask)));
    let code = ended.recv_timeout(std::time::Duration::from_secs(2)).expect("the shell on the pane's terminal runs and ends");
    assert_eq!(code, 0, "the shell on the pane's terminal did not end well");
    assert_eq!(std::fs::read_to_string(&said).unwrap(), "/opt/wsp/uv/tools xterm-256color\n");
}

/// And the shell is what the pty waits on, not the terminal: a shell that leaves a job of its own running
/// leaves that job holding the slave, so the terminal reads no end at all. The pane's tab would stand open
/// for as long as the job runs, which is not what a pane on any other machine does.
#[test]
fn the_broker_ends_when_the_shell_does_even_with_a_job_still_holding_the_slave() {
    let dir = tempfile::tempdir().unwrap();
    let ask = Ask {
        cols: 80,
        rows: 24,
        cwd: PathBuf::from("/"),
        size_file: dir.path().join("pty-2.size"),
        env: Vec::new(),
        argv: vec!["/bin/sh".to_owned(), "-c".to_owned(), "sleep 5 & printf 'and gone\n'; exit 9".to_owned()],
    };
    let (told, ended) = std::sync::mpsc::channel();
    std::thread::spawn(move || told.send(run(&ask)));
    let code = ended
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("the broker ends with the shell, rather than with the last job holding its terminal");
    assert_eq!(code, 9, "the broker exits with the shell's own code");
}
