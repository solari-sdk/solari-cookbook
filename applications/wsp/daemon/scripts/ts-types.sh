#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# The TypeScript types the protocol package re-exports, written from wsp-frames into packages/protocol/src/generated
# as .cargo/config.toml points ts-rs there. The folder is written from nothing, so a type the crate no longer has
# leaves with its file.
#
#   scripts/ts-types.sh           write the folder
#   scripts/ts-types.sh --check   write it, then fail where it differs from what the checkout holds: a hand edit,
#                                 a file added or removed by hand, or a crate change whose types were not written
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/../packages/protocol/src/generated"
rm -rf "$out"
(cd "$here" && cargo test --locked -q -p wsp-frames --lib export_bindings)
[ "${1:-}" = "--check" ] || exit 0
drift=$(git -C "$here" status --porcelain --untracked-files=all -- "$out")
[ -z "$drift" ] && exit 0
echo "packages/protocol/src/generated is not what wsp-frames writes: run daemon/scripts/ts-types.sh and commit it" >&2
echo "$drift" >&2
git -C "$here" --no-pager diff -- "$out" >&2
exit 1
