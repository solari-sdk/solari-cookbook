// SPDX-License-Identifier: AGPL-3.0-only
//! What wsp owns in the agents' homes on a computer the person joined: every path the list beside the recipe's job
//! names whose bytes there are still the ones wsp left. One shell script reads it, so the run that lands the files
//! again and the leave that takes them off read ownership the same way; the engine's landedFilesScript is the text
//! this renders, held to it byte for byte by the contract fixture, since the leave runs on both roads a leave runs
//! on and the daemon's road is this one.

use std::path::Path;

use crate::place_paths::place_provision_paths;
use crate::shell::shell_quote;

/// What the ownership read prints for one path of the list, so no path of the person's reads as the run's own words.
pub const OWN_MARK: &str = "wsp-own";

/// The field the list is split on and the end of one of the read's lines, as the text of these runs spells them: a
/// printf escape, never the character itself, so a script reads back on one line wherever it is printed.
const TAB: &str = "\\t";
const NL: &str = "\\n";

/// The run that reads what wsp owns under this home. It reads the computer and the list and nothing of any run, so
/// a leave still tells wsp's own copies from the person's.
pub fn landed_files_script(home: &Path) -> String {
    let at = place_provision_paths(home);
    [
        "set -u".to_owned(),
        format!("home={}; ledger={}", shell_quote(&home.to_string_lossy()), shell_quote(&at.landed.to_string_lossy())),
        r#"[ -f "$ledger" ] || exit 0"#.to_owned(),
        format!("tab=$(printf \"{TAB}\")"),
        r#"while IFS="$tab" read -r rel from at; do"#.to_owned(),
        r#"  dest="$home/$rel""#.to_owned(),
        r#"  [ -f "$dest" ] || continue"#.to_owned(),
        r#"  d=$(sha256sum "$dest" | cut -d" " -f1)"#.to_owned(),
        format!("  [ \"$d\" = \"$at\" ] && printf '{OWN_MARK}{TAB}%s{NL}' \"$rel\""),
        r#"done < "$ledger""#.to_owned(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// The paths that read answered with, home-relative and in the order the list named them. A line that is not the
/// mark's is not an answer: a path of the person's holding a newline prints lines this never reads as its own, and
/// a path that is not plainly under the home is no path of wsp's, whatever a list says, since joining an absolute
/// one onto the home would answer with the absolute one.
pub fn own_marks(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            (fields.next() == Some(OWN_MARK))
                .then(|| fields.collect::<Vec<_>>().join("\t"))
                .filter(|rel| !rel.is_empty() && !rel.starts_with('/') && !rel.split('/').any(|part| part == ".."))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_names_the_home_and_the_list_beside_the_job_and_hashes_what_stands_there() {
        let script = landed_files_script(Path::new("/home/maya"));
        assert!(script.contains("home='/home/maya'; ledger='/home/maya/.wsp/provision/landed'"), "{script}");
        assert!(script.contains("sha256sum"), "{script}");
        // The mark and the tab are printf escapes in the text, so a path with a newline in it cannot forge a line.
        assert!(script.contains(r"printf 'wsp-own\t%s\n'"), "{script}");
        // The home rides as it was given, as the engine's own generator quotes it, and the list beside the job is
        // the folder rule's, which strips what a shell would read as an empty segment anyway.
        assert!(landed_files_script(Path::new("/home/maya/")).contains("home='/home/maya/'; ledger='/home/maya/.wsp/provision/landed'"));
        // A home with a quote in it still reads back as one word.
        assert!(landed_files_script(Path::new("/home/o'brien")).contains(r"home='/home/o'\''brien'"));
    }

    #[test]
    fn only_the_marks_lines_are_read_as_answers() {
        let said =
            format!("{OWN_MARK}\t.claude/settings.json\nsomething the person printed\n{OWN_MARK}\t.codex/config.toml\n{OWN_MARK}\t\n");
        assert_eq!(own_marks(&said), [".claude/settings.json", ".codex/config.toml"]);
        assert!(own_marks("").is_empty());
        // A path with a tab of its own comes back whole: the mark is the first field and the path is the rest.
        assert_eq!(own_marks(&format!("{OWN_MARK}\t.claude/a\tb")), [".claude/a\tb"]);
        // Nothing outside the home is a path of wsp's, whatever a list on the computer says.
        assert!(own_marks(&format!("{OWN_MARK}\t/etc/hosts")).is_empty());
        assert!(own_marks(&format!("{OWN_MARK}\t../../etc/hosts")).is_empty());
    }
}
