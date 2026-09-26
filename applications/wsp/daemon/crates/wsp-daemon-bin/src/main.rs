// SPDX-License-Identifier: AGPL-3.0-only
//! The one binary: flags, the runtime, one process. Prints the listening line on stdout once bound and everything
//! else on stderr, one line per event.

mod flags;
mod score;
mod verbs;

use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::Instant;

use wsp_daemon::Daemon;
use wsp_frames::words;

/// Blocking work off the one runtime thread: pty reads, git, exec; small, and each thread's stack with it.
const BLOCKING_THREADS: usize = 4;
const BLOCKING_STACK_BYTES: usize = 256 * 1024;

fn main() {
    let started = Instant::now();
    let mut flags = flags::Flags::parse_or_exit();
    if let Some(verb) = flags.verb.take() {
        std::process::exit(verbs::run(verb));
    }
    let host = flags.host.clone();
    let port_file = flags.port_file.clone();
    let options = flags.into_options();
    score::apply();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(BLOCKING_THREADS)
        .thread_stack_size(BLOCKING_STACK_BYTES)
        .build()
        .unwrap_or_else(|e| {
            eprintln!("{}: {e}", words::FAILED_TO_START);
            std::process::exit(1)
        });
    let code = runtime.block_on(async move {
        let daemon = match Daemon::bind(options).await {
            Ok(d) => d,
            Err(e) => {
                eprintln!("{}: {e}", words::FAILED_TO_START);
                return 1;
            }
        };
        let port = daemon.local_addr().port();
        if let Some(path) = port_file {
            if let Err(e) = write_port_file(&path, port) {
                eprintln!("{}: {}: {e}", words::FAILED_TO_START, path.display());
                return 1;
            }
        }
        println!("{}", words::listening_line(&host, port));
        eprintln!("{}", words::ready_line(started.elapsed().as_millis()));
        match daemon.run().await {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("wsp-daemon stopped accepting: {e}");
                1
            }
        }
    });
    std::process::exit(code);
}

/// The port the daemon bound, where the host reads it back: the one thing it cannot know before the daemon is up.
fn write_port_file(path: &Path, port: u16) -> io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    writeln!(file, "{port}")
}
