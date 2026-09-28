// SPDX-License-Identifier: AGPL-3.0-only
//! The terminal a workspace's pane runs on, opened inside the workspace by this binary. The daemon on the
//! computer cannot make it: a container library's own terminal road wants a tenant built detached with a console
//! socket, and that tenant's seccomp load is refused by the kernel before any shell runs (measured on a box,
//! 6.8.0-139), while the plain exec tenant beside it loads the same filter and reads the same /dev/pts. So the
//! pty is opened on the inside, by an exec that is a plain exec in every way: the broker opens the pair from the
//! workspace's own /dev/ptmx, puts the shell on the slave as its controlling terminal, and is the wire between
//! that master and the pipes the exec already has. Nothing of the library's terminal handling is used.
//!
//! What a person types arrives on that exec's stdin and goes to the master; what the shell prints comes off the
//! master and goes to its stdout; a refusal of the workspace's own goes to its stderr, which is where the daemon
//! reads why a terminal never stood. A resize is the size written into a file of the workspace's own and a
//! window-change signal from the computer, since no frame can reach a process through a pipe carrying a person's
//! keystrokes.
//!
//! The two lines below, the broker's and the helper's, are rendered here and read back by the broker's own flags,
//! so the line a case drives against a stub is the line a box runs.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// What the pane asked for, as the daemon on the computer spells it and the broker inside reads it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    pub cols: u16,
    pub rows: u16,
    /// The folder the shell starts in, as the workspace sees it.
    pub cwd: PathBuf,
    /// Where the size of the pane is read at every window-change signal, as the workspace sees it.
    pub size_file: PathBuf,
    pub env: Vec<(String, String)>,
    /// The shell and its arguments.
    pub argv: Vec<String>,
}

/// The size a pane holds, as both sides of the file spell it: two numbers on one line, columns first.
pub fn size_line(cols: u16, rows: u16) -> String {
    format!("{cols} {rows}\n")
}

/// The pair back off that line; nothing for anything else, since a half written file is read again at the next
/// signal and a size this could not read is one the pty keeps as it was.
pub fn size_of(text: &str) -> Option<(u16, u16)> {
    let mut words = text.split_whitespace();
    let cols = words.next()?.parse().ok()?;
    let rows = words.next()?.parse().ok()?;
    Some((cols, rows))
}

/// The broker's own line, run inside the workspace by the binary bound there as its init.
pub fn broker_line(init: &str, ask: &Ask) -> Vec<String> {
    let mut line = vec![
        init.to_owned(),
        "runtime".to_owned(),
        "pty".to_owned(),
        "--cols".to_owned(),
        ask.cols.to_string(),
        "--rows".to_owned(),
        ask.rows.to_string(),
        "--cwd".to_owned(),
        ask.cwd.to_string_lossy().into_owned(),
        "--size-file".to_owned(),
        ask.size_file.to_string_lossy().into_owned(),
    ];
    for (name, value) in &ask.env {
        line.push("--env".to_owned());
        line.push(format!("{name}={value}"));
    }
    line.push("--".to_owned());
    line.extend(ask.argv.iter().cloned());
    line
}

/// The whole line the exec helper is given: a plain exec of that broker inside the workspace, with no deadline,
/// since a person's shell runs until they end it, and the file the library writes the tenant's pid into the
/// moment it is made.
pub fn helper_argv(root: &Path, id: &str, pid_file: &Path, broker: &[String]) -> Vec<String> {
    let mut line = vec![
        "runtime".to_owned(),
        "exec".to_owned(),
        "--root".to_owned(),
        root.to_string_lossy().into_owned(),
        "--id".to_owned(),
        id.to_owned(),
        "--pid-file".to_owned(),
        pid_file.to_string_lossy().into_owned(),
        "--".to_owned(),
    ];
    line.extend(broker.iter().cloned());
    line
}

/// The helper started with all three pipes, and the two ends of the pane's road taken off it at once. Taken here
/// and not later: a wait on a child drops its stdin the moment it is polled, so a pane whose keystrokes had
/// nowhere to go would be a terminal that prints and never answers.
pub fn start(exe: &Path, args: &[String]) -> io::Result<(Child, ChildStdin, ChildStdout)> {
    let mut cmd = Command::new(exe);
    cmd.args(args);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.process_group(0).kill_on_drop(true);
    let mut child = cmd.spawn()?;
    let taken = child.stdin.take().zip(child.stdout.take());
    let Some((input, output)) = taken else {
        return Err(io::Error::other("the helper was started without its pipes"));
    };
    Ok((child, input, output))
}

pub use inside::run;

/// The half that runs inside the workspace: the pty, the shell on it, and the pump between that pty and this
/// process's own pipes. Every call it makes is POSIX, so it builds on the computer the work is done on and its
/// cases run there; a workspace of its own is still the only place it is ever run.
mod inside {
    use std::fs;
    use std::io::{self, ErrorKind, Read, Write};
    use std::os::fd::{AsFd, AsRawFd, OwnedFd};
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    use nix::pty::{openpty, Winsize};
    use nix::sys::signal::{sigaction, SaFlags, SigAction, SigHandler, SigSet, Signal};
    use nix::unistd::setsid;

    use super::{size_of, Ask};

    /// What a failure of this process's own prints before it exits, and the code it exits with: the daemon reads
    /// the line off the exec's stderr, which is where a workspace's own refusals reach the computer.
    const PTY_PREFIX: &str = "wsp-runtime pty: ";
    const PTY_FAILED: i32 = 125;

    /// The two requests this module makes of a terminal. Each platform types a request the width its own ioctl
    /// takes, and one of the two spells the constants another way, so the pair is named here and not at the call.
    #[cfg(target_os = "macos")]
    mod request {
        pub(super) const CONTROLLING_TERMINAL: nix::libc::c_ulong = nix::libc::TIOCSCTTY as nix::libc::c_ulong;
        pub(super) const WINDOW_SIZE: nix::libc::c_ulong = nix::libc::TIOCSWINSZ as nix::libc::c_ulong;
    }

    #[cfg(not(target_os = "macos"))]
    mod request {
        pub(super) const CONTROLLING_TERMINAL: nix::libc::Ioctl = nix::libc::TIOCSCTTY;
        pub(super) const WINDOW_SIZE: nix::libc::Ioctl = nix::libc::TIOCSWINSZ;
    }

    /// Set by the window-change signal and read by the pump, which is all a handler may do.
    static RESIZED: AtomicBool = AtomicBool::new(false);
    extern "C" fn window_changed(_: i32) {
        RESIZED.store(true, Ordering::Relaxed);
    }

    /// Nothing to do and everything to be: a handler is what makes the signal cut the wait below short, where the
    /// default for a child that ended is to be dropped and to interrupt nothing. What the pump does next is ask
    /// the shell itself whether it was that one.
    extern "C" fn child_went(_: i32) {}

    /// How long the pump waits on the terminal before asking whether the shell is still there. A signal cuts the
    /// wait short, so this is the backstop and not the answer's speed.
    const CHILD_TICK: u16 = 200;
    /// And how long it waits for more once the shell has gone: what the terminal still holds is that shell's
    /// last bytes, and a span with nothing in it is the end of them.
    const DRAIN_TICK: u16 = 100;

    /// Whether the terminal has something to read within the wait. Anything that cuts the wait short, a signal
    /// among it, reads as nothing this time round, since what the caller does next is ask after the shell.
    fn readable(master: &OwnedFd, within: u16) -> bool {
        let mut fds = [nix::poll::PollFd::new(master.as_fd(), nix::poll::PollFlags::POLLIN)];
        nix::poll::poll(&mut fds, within).is_ok_and(|ready| ready > 0)
    }

    fn winsize(cols: u16, rows: u16) -> Winsize {
        Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 }
    }

    /// The size on a pty's master, which is what the shell on its slave reads and what the kernel tells that
    /// shell's foreground group about.
    fn set_size(master: &OwnedFd, cols: u16, rows: u16) -> io::Result<()> {
        let size = winsize(cols, rows);
        // Safe: the descriptor is a pty master this process holds and the structure is the one the call reads.
        let done = unsafe { nix::libc::ioctl(master.as_raw_fd(), request::WINDOW_SIZE, &raw const size) };
        if done < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// One terminal, start to end; the code to exit with, which is the shell's own.
    pub fn run(ask: &Ask) -> i32 {
        match relay(ask) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("{PTY_PREFIX}{e}");
                PTY_FAILED
            }
        }
    }

    /// The shell on that slave, in a session of its own with the slave as its controlling terminal, which is what
    /// makes job control and the signal keys work. The command is built and spawned here so it is dropped here: a
    /// command holds the descriptors it was given for a child's stdio until it is dropped and not until it has
    /// spawned, and a slave still open in this process is a master that never reads its end, so the pump below
    /// would wait on a terminal nothing writes to any more and a pane whose shell exited would read nothing.
    fn shell_on(slave: &OwnedFd, ask: &Ask) -> io::Result<std::process::Child> {
        let mut cmd = Command::new(&ask.argv[0]);
        cmd.args(&ask.argv[1..]).current_dir(&ask.cwd);
        for (name, value) in &ask.env {
            cmd.env(name, value);
        }
        cmd.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave.try_clone()?));
        // Between the fork and the exec, where the slave is already this child's stdio.
        //
        // Safe: both calls are ones a forked child may make before it execs, and neither allocates.
        unsafe {
            cmd.pre_exec(|| {
                setsid()?;
                if nix::libc::ioctl(0, request::CONTROLLING_TERMINAL, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn()
    }

    fn relay(ask: &Ask) -> io::Result<i32> {
        let pair = openpty(Some(&winsize(ask.cols, ask.rows)), None)?;
        let (master, slave) = (pair.master, pair.slave);
        let mut shell = shell_on(&slave, ask)?;
        // And the last copy this process holds, the one the pair was opened with.
        drop(slave);
        // Neither handler restarts the call it cut, so the pump below reads a signal as a turn of its loop.
        //
        // Safe: each handler touches one atomic and nothing else.
        let action = SigAction::new(SigHandler::Handler(window_changed), SaFlags::empty(), SigSet::empty());
        unsafe { sigaction(Signal::SIGWINCH, &action) }?;
        let ended = SigAction::new(SigHandler::Handler(child_went), SaFlags::empty(), SigSet::empty());
        unsafe { sigaction(Signal::SIGCHLD, &ended) }?;

        let typed = fs::File::from(master.try_clone()?);
        std::thread::spawn(move || to_shell(typed));
        let mut printed = fs::File::from(master.try_clone()?);
        let mut out = io::stdout();
        let mut buf = [0u8; 8 * 1024];
        // The pty is over when the shell is, and not when the terminal reads its end: a shell that left a job of
        // its own running behind it, `sleep 900 &` and then `exit`, leaves that job holding the slave, and a
        // pump that waited on the terminal would hold the pane's tab open for as long as the job runs. So the
        // wait is short and the shell itself is asked, which is what a pane on any other machine reads.
        let mut gone = None;
        loop {
            if RESIZED.swap(false, Ordering::Relaxed) {
                if let Some((cols, rows)) = fs::read_to_string(&ask.size_file).ok().as_deref().and_then(size_of) {
                    let _ = set_size(&master, cols, rows);
                }
            }
            if !readable(&master, if gone.is_some() { DRAIN_TICK } else { CHILD_TICK }) {
                // Nothing to read this time round. Once the shell has gone that is the last of what it printed;
                // until then it is the moment to ask whether it is still there.
                if gone.is_some() {
                    break;
                }
                match shell.try_wait() {
                    Ok(Some(status)) => gone = Some(status),
                    Ok(None) => {}
                    Err(_) => break,
                }
                continue;
            }
            match printed.read(&mut buf) {
                // The road closing, either way a kernel says it: end of file, or the last slave gone.
                Ok(0) => break,
                Ok(n) => {
                    if out.write_all(&buf[..n]).is_err() || out.flush().is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                // A pty whose shell has ended reads this on Linux rather than end of file; it is the road
                // closing and never something to read again.
                Err(e) if e.raw_os_error() == Some(nix::libc::EIO) => break,
                Err(_) => break,
            }
        }
        // The shell's own status is what this process exits with, so the helper on the computer carries it and
        // the pane reads the code the person's shell ended on.
        let ended = match gone {
            Some(status) => status,
            None => shell.wait()?,
        };
        let _ = fs::remove_file(&ask.size_file);
        Ok(ended.code().unwrap_or_else(|| 128 + ended.signal().unwrap_or(0)))
    }

    /// What a person types, off this process's stdin and onto the master. Its own thread: the pump above is
    /// blocked on the master, and a shell that prints nothing must not hold a keystroke.
    fn to_shell(mut master: fs::File) {
        let mut stdin = io::stdin();
        let mut buf = [0u8; 8 * 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => {
                    if master.write_all(&buf[..n]).is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return,
            }
        }
    }
}

// No case here runs the broker: it takes SIGCHLD from the tokio child waits below, so its cases are tests/pty_broker.rs.
#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn ask() -> Ask {
        Ask {
            cols: 100,
            rows: 40,
            cwd: PathBuf::from("/root/project"),
            size_file: PathBuf::from("/root/.wsp/pty-1.size"),
            env: vec![("HOME".to_owned(), "/root".to_owned()), ("TERM".to_owned(), "xterm-256color".to_owned())],
            argv: vec!["bash".to_owned(), "-l".to_owned()],
        }
    }

    /// The stub on disk, executable and closed here, and the spawn of it retried while the file is busy: any
    /// fork in this test binary while a stub is open for writing hands the child that descriptor until it execs,
    /// and an exec of that stub reads ETXTBSY until the last such descriptor is closed.
    fn spawn_stub<T>(stub: &Path, text: &str, mut spawn: impl FnMut() -> io::Result<T>) -> T {
        const TRIES: u32 = 20;
        const GAP: std::time::Duration = std::time::Duration::from_millis(5);
        std::fs::write(stub, text).unwrap();
        std::fs::set_permissions(stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        for _ in 1..TRIES {
            match spawn() {
                Err(e) if e.kind() == io::ErrorKind::ExecutableFileBusy => std::thread::sleep(GAP),
                taken => return taken.unwrap(),
            }
        }
        spawn().unwrap()
    }

    #[test]
    fn the_size_is_two_numbers_on_one_line_and_reads_back_as_it_was_written() {
        assert_eq!(size_line(100, 40), "100 40\n");
        assert_eq!(size_of(&size_line(100, 40)), Some((100, 40)));
        assert_eq!(size_of("80 24"), Some((80, 24)));
        // A file half written, or one holding anything else, is no size: the pty keeps the one it has.
        assert_eq!(size_of("100"), None);
        assert_eq!(size_of(""), None);
        assert_eq!(size_of("wide 40"), None);
        assert_eq!(size_of("100000 40"), None);
    }

    #[test]
    fn the_line_names_the_broker_inside_and_the_exec_that_runs_it() {
        let broker = broker_line("/sbin/wsp-init", &ask());
        assert_eq!(
            broker,
            [
                "/sbin/wsp-init",
                "runtime",
                "pty",
                "--cols",
                "100",
                "--rows",
                "40",
                "--cwd",
                "/root/project",
                "--size-file",
                "/root/.wsp/pty-1.size",
                "--env",
                "HOME=/root",
                "--env",
                "TERM=xterm-256color",
                "--",
                "bash",
                "-l",
            ]
        );
        let whole = helper_argv(Path::new("/wsp"), "wsp-a", Path::new("/wsp/run/wsp-a/pty-1.pid"), &broker);
        assert_eq!(whole[..9], ["runtime", "exec", "--root", "/wsp", "--id", "wsp-a", "--pid-file", "/wsp/run/wsp-a/pty-1.pid", "--"]);
        assert_eq!(whole[9..], broker[..]);
        // No deadline on this exec: the shell ends when the person ends it.
        assert!(!whole.contains(&"--timeout-ms".to_owned()));
    }

    /// The helper as the daemon starts it, against a stub standing for this binary: the line reaches it whole,
    /// what is typed reaches its stdin, what it prints comes back on stdout, and its stderr is a pipe of its own.
    /// A wait on a child drops that child's stdin, so a pane could be left unable to type with nothing red but a
    /// box; this is that shape pinned without one.
    #[tokio::test]
    async fn the_helper_is_started_with_all_three_pipes_and_the_line_it_was_given() {
        let dir = tempfile::tempdir().unwrap();
        let stub = dir.path().join("stub.sh");
        let broker = broker_line("/sbin/wsp-init", &ask());
        let args = helper_argv(Path::new("/wsp"), "wsp-a", Path::new("/wsp/run/wsp-a/pty-1.pid"), &broker);
        let text = "#!/bin/sh\necho \"$@\"\necho 'a refusal of its own' >&2\nexec cat\n";
        let (mut helper, mut input, mut output) = spawn_stub(&stub, text, || start(&stub, &args));

        input.write_all(b"typed\n").await.unwrap();
        input.flush().await.unwrap();
        // The stub ends its copy at end of file, which is this end going.
        drop(input);
        let mut printed = String::new();
        output.read_to_string(&mut printed).await.unwrap();
        let (line, typed) = printed.split_once('\n').expect("the line the stub was given, then what it copied");
        assert_eq!(line, args.join(" "));
        assert_eq!(typed, "typed\n");

        // The third pipe is the helper's own, which is where the sentence a terminal never stood is read.
        let mut said = String::new();
        helper.stderr.take().unwrap().read_to_string(&mut said).await.unwrap();
        assert_eq!(said, "a refusal of its own\n");
        assert!(helper.wait().await.unwrap().success());
    }

    /// Why the pipes are taken as the helper starts and never after: a wait on a child drops that child's stdin
    /// the moment it is polled, so a readiness race that waited first would leave a pane able to read and unable
    /// to type, with nothing red but a box.
    #[tokio::test]
    async fn a_wait_on_the_helper_drops_its_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let stub = dir.path().join("stub.sh");
        let mut child = spawn_stub(&stub, "#!/bin/sh\nexec cat\n", || {
            let mut cmd = Command::new(&stub);
            cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
            cmd.spawn()
        });
        assert!(child.stdin.is_some(), "a child started with a piped stdin holds it");
        let _ = tokio::time::timeout(std::time::Duration::from_millis(100), child.wait()).await;
        assert!(child.stdin.is_none(), "the wait left this child's stdin in place");
        let _ = child.start_kill();
    }

    /// A stub another thread holds open for writing is a file no exec in this process may run, which is what a
    /// fork racing another case's write leaves behind; the spawn takes it the moment that thread closes it.
    #[tokio::test]
    async fn a_stub_another_thread_holds_open_for_writing_is_spawned_once_it_closes() {
        let dir = tempfile::tempdir().unwrap();
        let stub = dir.path().join("stub.sh");
        let held = stub.clone();
        let (opened, holding) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let open = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&held).unwrap();
            opened.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
            drop(open);
        });
        holding.recv().unwrap();
        let broker = broker_line("/sbin/wsp-init", &ask());
        let args = helper_argv(Path::new("/wsp"), "wsp-a", Path::new("/wsp/run/wsp-a/pty-1.pid"), &broker);
        let (mut helper, _input, _output) = spawn_stub(&stub, "#!/bin/sh\nexit 0\n", || start(&stub, &args));
        assert!(helper.wait().await.unwrap().success(), "the stub spawned once the thread writing it closed its file");
        holder.join().unwrap();
    }
}
