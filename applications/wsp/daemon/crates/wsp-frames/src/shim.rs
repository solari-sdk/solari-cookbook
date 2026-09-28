// SPDX-License-Identifier: AGPL-3.0-only
//! The wsp a process inside a machine runs, as two lines of shell onto the binary that answers the word. The
//! host's deploy writes it on a fork and the workspace runtime writes it into a workspace's own upper on a
//! computer somebody owns; the text is here so the two roads cannot spell it apart, and the protocol's twin is
//! held to it by the contract fixture.

/// The shim at `numbers::GUEST_WSP_PATH`, handing the whole line to the binary named.
pub fn guest_wsp_shim(binary: &str) -> String {
    format!("#!/bin/sh\nexec {binary} wsp \"$@\"\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shim_hands_the_line_on_whole_to_the_binary_it_names() {
        assert_eq!(guest_wsp_shim("/sbin/wsp-init"), "#!/bin/sh\nexec /sbin/wsp-init wsp \"$@\"\n");
    }
}
