#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Samples the root disk and every process's writing once a second, so a writer
# that fills the disk and vanishes can still be named afterwards. Reads /proc,
# so it runs on the Linux boxes, not on a Mac.
#   df.log  root-disk use per second
#   fd.log  open files over min_mb, including ones unlinked while still held:
#           those keep blocks that df counts and du cannot see. Carries file
#           paths, so read it before pasting it anywhere public.
#   io.log  processes that wrote more than min_mb in the last second, which
#           names a writer that spreads its bytes over many small files
# A command line is printed as its program and its flag names only, never a
# value: a value on argv can be a key, and these logs go into public comments.
# Usage: scripts/watch-disk.sh <logdir> [seconds] [min_mb]

set -eu
LOGDIR=${1:?usage: watch-disk.sh <logdir> [seconds] [min_mb]}
RUN_FOR=${2:-3600}
MIN_MB=${3:-64}
mkdir -p "$LOGDIR"
DF_LOG="$LOGDIR/df.log"
FD_LOG="$LOGDIR/fd.log"
IO_LOG="$LOGDIR/io.log"
PREV="$LOGDIR/.io-prev"
NOW_FILE="$LOGDIR/.io-now"
MIN_BYTES=$((MIN_MB * 1048576))

# argv, printed safely: the program's own name, then flag names with any
# attached value cut at the "=". Everything else on argv is dropped.
flag_names() {
  tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null | awk '
    NR == 1 { n = split($0, p, "/"); printf "%s", p[n]; next }
    /^-/ { i = index($0, "="); printf " %s", (i > 0 ? substr($0, 1, i) : $0) }
  '
}

: > "$PREV"
DEADLINE=$(($(date -u +%s) + RUN_FOR))
while [ "$(date -u +%s)" -lt "$DEADLINE" ]; do
  NOW=$(date -u +%H:%M:%S)
  df -k / | awk -v t="$NOW" 'NR==2 {print t" used_kb="$3" avail_kb="$4" pct="$5}' >> "$DF_LOG"

  # One stat per process, not one per open file: on a 2 vCPU box a fork per fd
  # costs more than the sample is worth.
  : > "$NOW_FILE"
  for FDDIR in /proc/[0-9]*/fd; do
    PID=${FDDIR%/fd}
    PID=${PID#/proc/}
    COMM=$(cat "/proc/$PID/comm" 2>/dev/null) || continue
    WROTE=$(awk '/^write_bytes:/ {print $2}' "/proc/$PID/io" 2>/dev/null) || WROTE=""
    [ -n "$WROTE" ] && printf '%s\t%s\t%s\t%s\n' "$PID" "$WROTE" "$COMM" "$(flag_names "$PID")" >> "$NOW_FILE"
    stat -Lc '%n %s' "$FDDIR"/* 2>/dev/null | while read -r FDPATH SIZE; do
      [ "$SIZE" -gt "$MIN_BYTES" ] 2>/dev/null || continue
      TARGET=$(readlink "$FDPATH" 2>/dev/null) || TARGET="?"
      echo "$NOW pid=$PID size_mb=$((SIZE / 1048576)) comm=$COMM path=$TARGET" >> "$FD_LOG"
    done
  done

  # Lifetime write_bytes says nothing about this second: systemd has written
  # hundreds of gigabytes since boot. Only the rise since the last sample does.
  awk -F '\t' -v t="$NOW" -v min="$MIN_BYTES" '
    NR == FNR { prev[$1] = $2; next }
    ($1 in prev) && ($2 - prev[$1]) > min { printf "%s pid=%s wrote_mb=%d comm=%s cmd=%s\n", t, $1, ($2 - prev[$1]) / 1048576, $3, $4 }
  ' "$PREV" "$NOW_FILE" >> "$IO_LOG"
  mv "$NOW_FILE" "$PREV"

  sleep 1
done
