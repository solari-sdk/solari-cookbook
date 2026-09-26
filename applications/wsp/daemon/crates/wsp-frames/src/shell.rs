// SPDX-License-Identifier: AGPL-3.0-only
//! One sh word, as the protocol's shellQuote spells it. Here rather than beside a caller: the daemon writes script
//! text a shell on a machine reads back, and so does the host, and a second spelling of the quoting rule is a
//! second thing to get wrong about a path with a quote in it.

/// A value as sh reads it back unchanged: single quotes, with each quote inside closed, escaped and reopened.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quote_inside_a_word_is_closed_escaped_and_reopened() {
        assert_eq!(shell_quote("/home/maya"), "'/home/maya'");
        assert_eq!(shell_quote("/home/o'brien/x"), r"'/home/o'\''brien/x'");
        assert_eq!(shell_quote(""), "''");
    }
}
