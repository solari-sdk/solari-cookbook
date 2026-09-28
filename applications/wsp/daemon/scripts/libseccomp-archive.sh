#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# libseccomp's archive where .cargo/config.toml points the static link, in a directory of its own: the archive
# ships beside glibc's libc.a, and a search path there makes the musl link pick that libc up.
#
#   scripts/libseccomp-archive.sh        the distribution's archive (libseccomp-dev), for the glibc build
#   scripts/libseccomp-archive.sh musl   libseccomp built against musl from its pinned release, for the static
#                                        build; the distribution's archive carries glibc's fortified symbols,
#                                        which musl has not got. Needs musl-tools, gperf and the kernel headers.
#                                        Build with LIBSECCOMP_LIB_PATH=$PWD/target/libseccomp/musl.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
case "${1:-}" in
  "")
    src=$(ls /usr/lib/*/libseccomp.a /usr/lib64/libseccomp.a /usr/lib/libseccomp.a 2>/dev/null | head -1)
    [ -n "$src" ] || { echo "libseccomp.a not found: install libseccomp-dev" >&2; exit 1; }
    install -D -m 644 "$src" "$here/target/libseccomp/libseccomp.a"
    echo "$here/target/libseccomp/libseccomp.a"
    ;;
  musl)
    version=2.5.5
    sha256=248a2c8a4d9b9858aa6baf52712c34afefcf9c9e94b76dce02c1c9aa25fb3375
    work="$here/target/libseccomp/musl-build"
    out="$here/target/libseccomp/musl/libseccomp.a"
    if [ -f "$out" ]; then echo "$out"; exit 0; fi
    rm -rf "$work" && mkdir -p "$work" && cd "$work"
    curl -sSL -o "libseccomp-$version.tar.gz" "https://github.com/seccomp/libseccomp/releases/download/v$version/libseccomp-$version.tar.gz"
    echo "$sha256  libseccomp-$version.tar.gz" | sha256sum -c - > /dev/null
    tar xzf "libseccomp-$version.tar.gz" && cd "libseccomp-$version"
    # musl's own headers first; the kernel's linux/ and asm/ headers, which musl-tools does not carry, after them.
    CC=musl-gcc CPPFLAGS="-idirafter /usr/include/$(gcc -print-multiarch) -idirafter /usr/include" \
      ./configure --enable-static --disable-shared --host="$(uname -m)-linux-musl" > configure.log
    make -j2 > make.log
    install -D -m 644 src/.libs/libseccomp.a "$out"
    echo "$out"
    ;;
  *)
    echo "usage: $0 [musl]" >&2
    exit 2
    ;;
esac
