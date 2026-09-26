// SPDX-License-Identifier: AGPL-3.0-only
//! libseccomp links statically or the build stops. libseccomp-sys reads the link type from LIBSECCOMP_LINK_TYPE,
//! which daemon/.cargo/config.toml sets, and cargo reads that file only when it runs under daemon/. A build run
//! from anywhere else asked the linker for a shared libseccomp, and a box that had one put it into the static-pie
//! binary as a dependency nothing loads, so the container's init called address zero at its first seccomp call.

use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=LIBSECCOMP_LINK_TYPE");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    if env::var("LIBSECCOMP_LINK_TYPE").as_deref() != Ok("static") {
        eprintln!("libseccomp must link statically: run cargo from daemon/, where .cargo/config.toml sets LIBSECCOMP_LINK_TYPE=static, or set it yourself");
        std::process::exit(1);
    }
}
