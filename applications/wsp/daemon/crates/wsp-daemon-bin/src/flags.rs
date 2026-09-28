// SPDX-License-Identifier: AGPL-3.0-only
//! One flag per daemon option, so the test harness and the deploy scripts spell the same thing. The interval and
//! deadline flags exist for the suite; the deploy scripts never name them. A verb in front of the flags runs a
//! debug verb instead of the daemon.

use std::path::PathBuf;

use clap::error::ErrorKind;
use clap::Parser;
use wsp_daemon::Options;
use wsp_frames::numbers;

use crate::verbs::Verb;

pub(crate) const USAGE: &str = "usage: wsp-daemon [--host <addr>] [--port <n>] [--token-path <file>] [--root <dir>] [--roots-path <file>] [--kind cloud|local|ssh|place] [--work-folder <dir>] [--inbox <dir>] [--inbox-quiet-ms <n>] [--inbox-poll-ms <n>] [--manifest <file>] [--run-dir <dir>] [--log-dir <dir>] [--open-socket <path>] [--port-file <file>] [--proc-root <dir>] [--passwd <file>] [--ports-interval-ms <n>] [--sys-interval-ms <n>] [--proc-interval-ms <n>] [--mode-interval-ms <n>] [--auth-deadline-ms <n>] [--place-file <file>] [--home <dir>] [--wsp-argv <word>]... [--agents id=bin,...] [--link-connect-ms <n>] [--link-quiet-ms <n>] [--link-refused-retry-ms <n>] [--link-backoff-ms <n>] [--runtime-root <dir>]";

#[derive(Debug, Parser)]
#[command(name = "wsp-daemon", disable_version_flag = true, override_usage = USAGE)]
pub(crate) struct Flags {
    /// A debug verb instead of serving: runs, prints, exits.
    #[command(subcommand)]
    pub(crate) verb: Option<Verb>,
    /// The address to bind: 0.0.0.0 in a guest, 127.0.0.1 on a computer somebody owns.
    #[arg(long, default_value = numbers::DEFAULT_HOST, value_name = "addr")]
    pub(crate) host: String,
    /// 0 takes any free port; the listening line and --port-file say which.
    #[arg(long, default_value_t = numbers::DEFAULT_PORT, value_name = "n")]
    pub(crate) port: u16,
    #[arg(long, default_value = numbers::DEFAULT_TOKEN_PATH, value_name = "file")]
    pub(crate) token_path: PathBuf,
    #[arg(long, value_name = "dir")]
    pub(crate) root: Option<PathBuf>,
    #[arg(long, value_name = "file")]
    pub(crate) roots_path: Option<PathBuf>,
    // Any word: a kind the daemon lacks is refused at the watch, in the words the pane prints, not here.
    #[arg(long, default_value = "cloud", value_name = "cloud|local|ssh|place")]
    pub(crate) kind: String,
    #[arg(long, value_name = "dir")]
    pub(crate) work_folder: Option<PathBuf>,
    #[arg(long, value_name = "dir")]
    pub(crate) inbox: Option<PathBuf>,
    #[arg(long, value_name = "n")]
    pub(crate) inbox_quiet_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) inbox_poll_ms: Option<u64>,
    #[arg(long, value_name = "file")]
    pub(crate) manifest: Option<PathBuf>,
    #[arg(long, value_name = "dir")]
    pub(crate) run_dir: Option<PathBuf>,
    #[arg(long, value_name = "dir")]
    pub(crate) log_dir: Option<PathBuf>,
    #[arg(long, value_name = "path")]
    pub(crate) open_socket: Option<PathBuf>,
    #[arg(long, value_name = "file")]
    pub(crate) port_file: Option<PathBuf>,
    #[arg(long, value_name = "dir")]
    pub(crate) proc_root: Option<PathBuf>,
    #[arg(long, value_name = "file")]
    pub(crate) passwd: Option<PathBuf>,
    #[arg(long, value_name = "n")]
    pub(crate) ports_interval_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) sys_interval_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) proc_interval_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) mode_interval_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) auth_deadline_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) guest_unwatched_ms: Option<u64>,
    /// Turns the outbound link on: the file the join wrote, read on every attempt.
    #[arg(long, value_name = "file")]
    pub(crate) place_file: Option<PathBuf>,
    /// Where the place keeps its files and what the sweep takes.
    #[arg(long, value_name = "dir")]
    pub(crate) home: Option<PathBuf>,
    /// The line that runs wsp on this place, one word per flag.
    #[arg(long = "wsp-argv", value_name = "word", action = clap::ArgAction::Append)]
    pub(crate) wsp_argv: Vec<String>,
    /// The agents to look for on this place, as catalog id and binary name.
    #[arg(long, value_name = "id=bin,...", value_delimiter = ',')]
    pub(crate) agents: Vec<String>,
    #[arg(long, value_name = "n")]
    pub(crate) link_connect_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) link_quiet_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) link_refused_retry_ms: Option<u64>,
    #[arg(long, value_name = "n")]
    pub(crate) link_backoff_ms: Option<u64>,
    /// Where a place's daemon keeps the workspaces it runs, their copies of a project and the checkouts those
    /// are made from; /wsp when absent.
    #[arg(long, value_name = "dir")]
    pub(crate) runtime_root: Option<PathBuf>,
}

impl Flags {
    /// The flags, or the usage line the node bin prints and exit 2; --help prints clap's own and exits 0.
    pub(crate) fn parse_or_exit() -> Flags {
        match Flags::try_parse() {
            Ok(flags) => flags,
            Err(e) if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) => {
                let _ = e.print();
                std::process::exit(0)
            }
            Err(e) => {
                let rendered = e.render().to_string();
                eprintln!("{}", rendered.lines().next().unwrap_or("bad flags"));
                eprintln!("{USAGE}");
                std::process::exit(2)
            }
        }
    }

    pub(crate) fn into_options(self) -> Options {
        Options {
            host: self.host,
            port: self.port,
            token_path: self.token_path,
            root: self.root,
            roots_path: self.roots_path,
            kind: self.kind,
            work_folder: self.work_folder,
            inbox_dir: self.inbox,
            inbox_quiet_ms: self.inbox_quiet_ms,
            inbox_poll_ms: self.inbox_poll_ms,
            manifest_path: self.manifest,
            run_dir: self.run_dir,
            log_dir: self.log_dir,
            open_socket_path: self.open_socket,
            proc_root: self.proc_root,
            passwd_path: self.passwd,
            ports_interval_ms: self.ports_interval_ms,
            sys_interval_ms: self.sys_interval_ms,
            proc_interval_ms: self.proc_interval_ms,
            mode_interval_ms: self.mode_interval_ms,
            auth_deadline_ms: self.auth_deadline_ms,
            guest_unwatched_ms: self.guest_unwatched_ms,
            // The rule's own second: no flag shortens it, since only a case has any use for another number.
            token_watch_ms: None,
            place_file: self.place_file,
            // Read off the process by the bind, before the probe list takes its place; no flag names it.
            unit_path: None,
            home: self.home,
            wsp_argv: self.wsp_argv,
            agents: self.agents,
            link_connect_ms: self.link_connect_ms,
            link_quiet_ms: self.link_quiet_ms,
            link_refused_retry_ms: self.link_refused_retry_ms,
            link_backoff_ms: self.link_backoff_ms,
            runtime_root: self.runtime_root,
            // This binary is the helper the workspace runtime runs, which is what current_exe answers for it.
            runtime_helper: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Flags, clap::Error> {
        Flags::try_parse_from(std::iter::once("wsp-daemon").chain(args.iter().copied()))
    }

    #[test]
    fn defaults_to_the_in_guest_shape() {
        let f = parse(&[]).unwrap();
        assert_eq!(f.host, "0.0.0.0");
        assert_eq!(f.port, 7070);
        // Under root's own wsp folder, which is the folder a workspace on a computer somebody joined has of
        // its own: the default a machine's daemon starts with is never a path in a folder it shares.
        assert_eq!(f.token_path, PathBuf::from("/root/.wsp/daemon-token"));
        assert_eq!(f.token_path, PathBuf::from(numbers::DEFAULT_TOKEN_PATH));
        assert_eq!(f.kind, "cloud");
        assert!(f.root.is_none());
    }

    #[test]
    fn parses_every_flag_in_the_list() {
        let f = parse(&[
            "--host",
            "127.0.0.1",
            "--port",
            "7171",
            "--token-path",
            "/tmp/tok",
            "--root",
            "/srv/work",
            "--roots-path",
            "/srv/roots",
            "--kind",
            "place",
            "--work-folder",
            "/w",
            "--inbox",
            "/i",
            "--inbox-quiet-ms",
            "10",
            "--inbox-poll-ms",
            "20",
            "--manifest",
            "/m.json",
            "--run-dir",
            "/r",
            "--log-dir",
            "/l",
            "--open-socket",
            "/o.sock",
            "--port-file",
            "/p",
            "--proc-root",
            "/proc2",
            "--passwd",
            "/pw",
            "--ports-interval-ms",
            "1",
            "--sys-interval-ms",
            "2",
            "--proc-interval-ms",
            "3",
            "--mode-interval-ms",
            "4",
            "--auth-deadline-ms",
            "5",
            "--place-file",
            "/pf",
            "--home",
            "/h",
            "--wsp-argv",
            "node",
            "--wsp-argv",
            "bin.js",
            "--agents",
            "one=one-bin,two=two-bin",
            "--link-connect-ms",
            "6",
            "--link-quiet-ms",
            "7",
            "--link-refused-retry-ms",
            "8",
            "--link-backoff-ms",
            "9",
            "--runtime-root",
            "/var/lib/wsp-test",
        ])
        .unwrap();
        let o = f.into_options();
        assert_eq!((o.host.as_str(), o.port), ("127.0.0.1", 7171));
        assert_eq!(o.kind, "place");
        assert_eq!(o.wsp_argv, vec!["node", "bin.js"]);
        assert_eq!(o.agents, vec!["one=one-bin", "two=two-bin"]);
        assert_eq!((o.inbox_quiet_ms, o.inbox_poll_ms, o.auth_deadline_ms), (Some(10), Some(20), Some(5)));
        assert_eq!((o.link_connect_ms, o.link_quiet_ms, o.link_refused_retry_ms, o.link_backoff_ms), (Some(6), Some(7), Some(8), Some(9)));
        assert_eq!(o.open_socket_path, Some(PathBuf::from("/o.sock")));
        assert_eq!(o.runtime_root, Some(PathBuf::from("/var/lib/wsp-test")));
        // No flag names the helper the workspace runtime runs, so a daemon on a machine runs this binary as it
        // always has: what names one is a test that opened a daemon inside its own process.
        assert_eq!(o.runtime_helper, None);
    }

    #[test]
    fn the_wsp_verb_hands_the_whole_line_on_untouched() {
        let line = |args: &[&str]| match parse(args).unwrap().verb {
            Some(Verb::Wsp { line }) => line,
            other => panic!("expected the wsp verb, got {other:?}"),
        };
        assert_eq!(line(&["wsp", "threads", "--json", "--host", "x"]), ["threads", "--json", "--host", "x"]);
        assert_eq!(line(&["wsp", "mcp"]), ["mcp"]);
        // The flags the daemon takes are not this line's: a word that looks like one goes over as it was typed.
        assert_eq!(line(&["wsp", "run", "t1", "--port", "9", "--", "a b"]), ["run", "t1", "--port", "9", "--", "a b"]);
        assert_eq!(line(&["wsp", "--help"]), ["--help"]);
        assert_eq!(line(&["wsp"]), Vec::<String>::new());
    }

    #[test]
    fn the_forward_verb_takes_the_wsp_it_runs_and_the_whole_line_after_the_cut() {
        let read = |args: &[&str]| match parse(args).unwrap().verb {
            Some(Verb::Forward { wsp_argv, line }) => (wsp_argv, line),
            other => panic!("expected the forward verb, got {other:?}"),
        };
        let (wsp, line) =
            read(&["forward", "--wsp-argv", "/app/wsp", "--wsp-argv", "/app/cli.mjs", "--", "mcp", "--state", "/s", "--wsp-argv", "x"]);
        assert_eq!(wsp, ["/app/wsp", "/app/cli.mjs"]);
        assert_eq!(line, ["mcp", "--state", "/s", "--wsp-argv", "x"]);
        // A word of node's own flags is a word of the wsp it runs, not one of this verb's.
        let (wsp, line) = read(&["forward", "--wsp-argv", "node", "--wsp-argv", "--no-warnings", "--wsp-argv", "bin.js", "--", "--help"]);
        assert_eq!(wsp, ["node", "--no-warnings", "bin.js"]);
        assert_eq!(line, ["--help"]);
        assert_eq!(read(&["forward", "--wsp-argv", "wsp", "--"]).1, Vec::<String>::new());
        assert!(parse(&["forward", "--", "mcp"]).is_err(), "a forwarder with no wsp to run has nothing to hand a line to");
    }

    #[test]
    fn refuses_a_missing_value_a_bad_port_and_an_unknown_flag() {
        assert!(parse(&["--host"]).is_err());
        assert!(parse(&["--port", "abc"]).is_err());
        assert!(parse(&["--port", "70000"]).is_err());
        assert!(parse(&["--token-path"]).is_err());
        // A kind the registry lacks parses; the daemon refuses it at the watch, in the words the pane prints.
        assert_eq!(parse(&["--kind", "moon"]).unwrap().kind, "moon");
        let e = parse(&["--wat"]).unwrap_err();
        assert!(e.render().to_string().contains("--wat"));
    }
}
