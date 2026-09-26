#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# The fake tool the guard tests put on PATH: linked under each tool's name, it prints the name it was called by
# and its arguments to stderr. One file in the repo rather than one written per run because macOS checks every
# newly written executable the first time it runs, which measured 120 ms to 420 ms per file on an idle Mac and
# multiples of that under load; a file that has run before is checked from cache.
echo "real-${0##*/}" "$@" >&2
