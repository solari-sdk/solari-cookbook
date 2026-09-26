#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# measure.sh <workspace-root> <port>
#
# Runs the Rust daemon beside the node daemon already serving this machine and prints both resident sizes once a
# minute for ten minutes: five minutes idle, then five with one pty on each daemon running a shell that prints a
# line a second. Builds nothing. The binary is read at daemon/target/release/wsp-daemon, which
#     cd daemon && cargo build --release -p wsp-daemon-bin
# makes as a glibc dynamic host build. The deploy ships the musl static build instead, from
#     cd daemon && cargo build --release --target x86_64-unknown-linux-musl -p wsp-daemon-bin
# (no libseccomp: the daemon links none), which is smaller and holds fewer pages after work; point WSP_DAEMON_BIN
# at it to measure the binary that ships. Either way the output names the linkage it read off the ELF, so a run is
# never silent about which one it measured. The node daemon's pid comes from the systemd unit wsp-daemon.service
# where one exists (a Box or an ssh fork) and otherwise from the pid file the container supervisor writes,
# /root/wsp-daemon/daemon.pid (a Docker fork). It listens on WSP_NODE_PORT (7070) with the token in
# WSP_NODE_TOKEN_PATH (/root/.wsp/daemon-token).
#
# RSS is VmRSS from /proc/<pid>/status, both the daemon's own and the sum over every process under it (a pty's
# shell and what it runs), read off /proc alone. The wire client is python3 and its standard library: it is on
# every machine the node daemon was deployed to, since the deploy checked for it before building node-pty. Nothing
# else is assumed beyond /proc, awk, od, grep and mktemp. WSP_MEASURE_STEP_SECONDS shortens the minute for a dry
# run. Ready time is the daemon's own "ready in <ms>" line, its clock from the top of main to the bind; nothing
# here times it from outside the process (that needs bash's /dev/tcp, and this is sh), so quote it as the bind
# time, not the exec-to-listening time.
#
# Output: comment lines start with #, then minute,node_daemon_kb,node_total_kb,rust_daemon_kb,rust_total_kb,state
# one line a minute, then the two tables as one block. At the end the ptys are killed over the wire, the two pty
# clients and the Rust daemon are stopped by the pids this script recorded, and the temp dir goes. The node daemon
# is never touched.
set -eu

usage() {
  echo "usage: measure.sh <workspace-root> <port>" >&2
  exit 2
}
[ $# -eq 2 ] || usage
root=$1
port=$2
[ -d "$root" ] || { echo "measure.sh: no such directory: $root" >&2; exit 2; }
case "$port" in
  ''|*[!0-9]*) usage ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
bin=${WSP_DAEMON_BIN:-"$here/../target/release/wsp-daemon"}
[ -x "$bin" ] || { echo "measure.sh: no binary at $bin; run: cd daemon && cargo build --release -p wsp-daemon-bin" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "measure.sh: python3 is needed for the wire client" >&2; exit 2; }

node_port=${WSP_NODE_PORT:-7070}
node_token_path=${WSP_NODE_TOKEN_PATH:-/root/.wsp/daemon-token}
[ -r "$node_token_path" ] || { echo "measure.sh: cannot read the node daemon's token at $node_token_path" >&2; exit 2; }
step=${WSP_MEASURE_STEP_SECONDS:-60}

node_pid=""
node_source=""
if command -v systemctl >/dev/null 2>&1; then
  node_pid=$(systemctl show -p MainPID --value wsp-daemon.service 2>/dev/null || true)
  [ -n "$node_pid" ] && [ "$node_pid" != "0" ] && node_source="systemd unit wsp-daemon.service"
fi
if [ -z "$node_source" ] && [ -r /root/wsp-daemon/daemon.pid ]; then
  node_pid=$(cat /root/wsp-daemon/daemon.pid)
  node_source="pid file /root/wsp-daemon/daemon.pid"
fi
[ -n "$node_source" ] || { echo "measure.sh: no node daemon found: neither wsp-daemon.service nor /root/wsp-daemon/daemon.pid" >&2; exit 2; }
[ -d "/proc/$node_pid" ] || { echo "measure.sh: the node daemon's pid $node_pid ($node_source) is not running" >&2; exit 2; }

tmp=$(mktemp -d)
rust_pid=""
client_pids=""
counted_pids=""
node_pty_id=""
rust_pty_id=""

cleanup() {
  status=$?
  trap - EXIT INT TERM
  # The shells end over the wire, by the pty id each daemon handed back: never by a pid a daemon owns. The node
  # daemon is left running, so its shell has to go this way; the Rust daemon's shell goes with the daemon below.
  [ -n "$node_pty_id" ] && python3 "$tmp/wire.py" kill 127.0.0.1 "$node_port" "$node_token_path" "$node_pty_id" >/dev/null 2>&1 || true
  [ -n "$rust_pty_id" ] && [ -n "$rust_pid" ] && python3 "$tmp/wire.py" kill 127.0.0.1 "$port" "$tmp/token" "$rust_pty_id" >/dev/null 2>&1 || true
  for p in $client_pids; do kill "$p" 2>/dev/null || true; done
  for p in $client_pids; do wait "$p" 2>/dev/null || true; done
  if [ -n "$rust_pid" ]; then
    kill "$rust_pid" 2>/dev/null || true
    wait "$rust_pid" 2>/dev/null || true
  fi
  # Everything this run started has to be gone: the two pty clients (each a python pid this script recorded, so a
  # kill reaches python and not a subshell around it), the Rust daemon and every process either fathered. The node
  # daemon and its own pid are the one thing left up, so they are excluded from the check.
  left=""
  for p in $client_pids $counted_pids; do
    [ "$p" = "$node_pid" ] && continue
    n=0
    while [ -d "/proc/$p" ] && [ "$n" -lt 30 ]; do sleep 0.1; n=$((n + 1)); done
    [ -d "/proc/$p" ] && left="$left $p"
  done
  echo "# stopped: rust pid ${rust_pid:-none}, the two pty clients and the two ptys; still running from what this run started:${left:- none}"
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$tmp/wire.py" <<'WIRE'
import base64, json, os, signal, socket, struct, sys, time

def frame(opcode, payload):
    head = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack(">Q", n)
    key = os.urandom(4)
    return head + key + bytes(b ^ key[i % 4] for i, b in enumerate(payload))

class Wire:
    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET / HTTP/1.1\r\nHost: %s:%s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n") % (host, port, key)
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise SystemExit("handshake: socket closed")
            buf += chunk
        head, _, self.rest = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise SystemExit("handshake refused: " + head.split(b"\r\n")[0].decode(errors="replace"))
        self.next_id = 1

    def read(self, n):
        while len(self.rest) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SystemExit("socket closed")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, obj):
        self.sock.sendall(frame(1, json.dumps(obj).encode()))

    def request(self, op, **params):
        i = self.next_id
        self.next_id += 1
        self.send(dict(id=i, op=op, **params))
        return i

    def recv(self):
        text = b""
        while True:
            b0, b1 = self.read(2)
            opcode, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self.read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self.read(8))[0]
            if b1 & 0x80:
                self.read(4)
            payload = self.read(n)
            if opcode == 8:
                code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else 1005
                raise SystemExit("closed %d %s" % (code, payload[2:].decode(errors="replace")))
            if opcode == 9:
                self.sock.sendall(frame(10, payload))
                continue
            if opcode == 10:
                continue
            text += payload
            if b0 & 0x80:
                return json.loads(text.decode())

    def until(self, want, deadline=10):
        end = time.time() + deadline
        while time.time() < end:
            self.sock.settimeout(max(0.1, end - time.time()))
            msg = self.recv()
            if want(msg):
                return msg
        raise SystemExit("timed out waiting for a frame")

    def reply(self, i):
        msg = self.until(lambda m: m.get("id") == i)
        if not msg.get("ok"):
            raise SystemExit("%s: %s" % (i, msg.get("error", msg)))
        return msg

    def close(self):
        try:
            self.sock.sendall(frame(8, struct.pack(">H", 1000)))
        except OSError:
            pass
        self.sock.close()

def open_wire(host, port, token):
    w = Wire(host, port)
    w.reply(w.request("auth", token=token))
    hello = w.until(lambda m: m.get("type") == "daemon.hello")
    return w, hello

mode, host, port, token_path = sys.argv[1:5]
with open(token_path) as f:
    token = f.read().strip()
w, hello = open_wire(host, int(port), token)
if mode == "hello":
    print("%s %s" % (hello.get("version", "none"), hello.get("root", "")))
    w.close()
    sys.exit(0)
if mode == "kill":
    # Reap one pty by id, so cleanup ends the shell over the wire and never by a pid the daemon owns.
    w.reply(w.request("pty.kill", ptyId=sys.argv[5]))
    w.close()
    sys.exit(0)

created = w.reply(w.request("pty.create", cols=80, rows=24, shell="sh", cwd=sys.argv[5]))
pty_id = created["ptyId"]
w.reply(w.request("pty.attach", ptyId=pty_id))
w.reply(w.request("pty.write", ptyId=pty_id, data="while :; do date; sleep 1; done\n"))
print("pty %s" % pty_id, flush=True)
# Stay attached, draining the line a second, until a signal ends the client. The pty is reaped by id in cleanup,
# not here, so the shell ends whether or not this client is still up when the run stops.
stop = []
signal.signal(signal.SIGTERM, lambda *a: stop.append(1))
signal.signal(signal.SIGINT, lambda *a: stop.append(1))
w.sock.settimeout(1)
while not stop:
    try:
        w.recv()
    except socket.timeout:
        pass
    except SystemExit as e:
        print("pty client: %s" % e, file=sys.stderr)
        sys.exit(1)
w.close()
WIRE

# Every process under a pid, read off ppid in /proc/*/stat: the children file is not in every kernel.
descendants() {
  queue=$1
  found=$1
  while [ -n "$queue" ]; do
    p=${queue%% *}
    case "$queue" in
      *" "*) queue=${queue#* } ;;
      *) queue="" ;;
    esac
    for f in /proc/[0-9]*/stat; do
      # A process may exit between the glob and the read; the whole redirect is guarded so a gone pid is skipped.
      { IFS= read -r line < "$f"; } 2>/dev/null || continue
      rest=${line##*) }
      set -- $rest
      [ $# -ge 2 ] && [ "$2" = "$p" ] || continue
      c=${f#/proc/}
      c=${c%/stat}
      found="$found $c"
      queue="${queue:+$queue }$c"
    done
  done
  printf '%s\n' "$found"
}

rss_of() {
  total=0
  for p in "$@"; do
    kb=$(awk '/^VmRSS:/ {print $2}' "/proc/$p/status" 2>/dev/null || true)
    total=$((total + ${kb:-0}))
  done
  printf '%s\n' "$total"
}

wire() {
  python3 "$tmp/wire.py" "$@"
}

cores=$(grep -c '^processor' /proc/cpuinfo)
mem_mb=$(awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo)
bin_bytes=$(wc -c < "$bin")
# The linkage read off the ELF alone, no file(1): a dynamic binary names its interpreter, a static one names none.
# Build B ships the musl static build; the host build the header's cargo line makes is glibc dynamic, and idle RSS
# differs between them, so the output says which one this run measured.
interp=$(LC_ALL=C grep -aom1 '/lib[^[:cntrl:]]*/ld-[a-z0-9-]*\.so[.0-9]*' "$bin" || true)
case "$interp" in
  *musl*) linkage="dynamic musl, interpreter $interp" ;;
  ?*) linkage="dynamic glibc, interpreter $interp" ;;
  *) linkage="static, no interpreter" ;;
esac
mkdir -p "$tmp/inbox" "$tmp/run" "$tmp/logs"
od -An -tx1 -N 24 /dev/urandom | tr -d ' \n' > "$tmp/token"
chmod 600 "$tmp/token"
: > "$tmp/roots"

"$bin" --host 127.0.0.1 --port "$port" --token-path "$tmp/token" --root "$root" --roots-path "$tmp/roots" \
  --inbox "$tmp/inbox" --manifest "$tmp/manifest.json" --run-dir "$tmp/run" --log-dir "$tmp/logs" \
  --open-socket "$tmp/open.sock" > "$tmp/rust.out" 2> "$tmp/rust.err" &
rust_pid=$!
n=0
until grep -q 'listening on' "$tmp/rust.out" 2>/dev/null; do
  if ! kill -0 "$rust_pid" 2>/dev/null || [ "$n" -ge 100 ]; then
    echo "measure.sh: the Rust daemon did not listen on port $port:" >&2
    cat "$tmp/rust.err" >&2
    exit 1
  fi
  sleep 0.1
  n=$((n + 1))
done
ready=$(grep -o 'ready in [0-9]* ms' "$tmp/rust.err" || echo "ready line missing")

rust_hello=$(wire hello 127.0.0.1 "$port" "$tmp/token")
node_hello=$(wire hello 127.0.0.1 "$node_port" "$node_token_path")

echo "# node daemon pid $node_pid from $node_source, port $node_port"
echo "# rust daemon pid $rust_pid from $bin ($bin_bytes bytes), port $port, $ready"
echo "# node hello: version ${node_hello%% *}, root ${node_hello#* }"
echo "# rust hello: version ${rust_hello%% *}, root ${rust_hello#* }"
echo "# machine: $(uname -m), $cores cores, $mem_mb MB, $(uname -sr)"
echo "# rust binary linkage: $linkage"
echo "# daemon_kb is the daemon's own VmRSS; total_kb adds every process under it (the pty's shell and its sleep)"
echo "minute,node_daemon_kb,node_total_kb,rust_daemon_kb,rust_total_kb,state"

: > "$tmp/rows"
started=$(date +%s)
state=idle
last_pids=""
minute=1
while [ "$minute" -le 10 ]; do
  due=$((started + step * minute))
  now=$(date +%s)
  [ "$due" -gt "$now" ] && sleep $((due - now))
  node_pids=$(descendants "$node_pid")
  rust_pids=$(descendants "$rust_pid")
  counted_pids="$node_pids $rust_pids"
  if [ "$counted_pids" != "$last_pids" ]; then
    echo "# counted at minute $minute: node [$node_pids] rust [$rust_pids]"
    last_pids=$counted_pids
  fi
  node_daemon_kb=$(rss_of "$node_pid")
  node_total_kb=$(rss_of $node_pids)
  rust_daemon_kb=$(rss_of "$rust_pid")
  rust_total_kb=$(rss_of $rust_pids)
  echo "$minute,$node_daemon_kb,$node_total_kb,$rust_daemon_kb,$rust_total_kb,$state"
  echo "$minute|$node_daemon_kb|$node_total_kb|$rust_daemon_kb|$rust_total_kb|$state|$node_pids|$rust_pids" >> "$tmp/rows"
  if [ "$minute" -eq 5 ]; then
    # python is backgrounded straight, not through the wire function: a function backgrounded runs in a subshell
    # and $! would be the subshell's pid, leaving python orphaned when cleanup kills the pid it recorded.
    python3 "$tmp/wire.py" pty 127.0.0.1 "$node_port" "$node_token_path" "$root" > "$tmp/node-pty.out" 2> "$tmp/node-pty.err" &
    client_pids=$!
    python3 "$tmp/wire.py" pty 127.0.0.1 "$port" "$tmp/token" "$root" > "$tmp/rust-pty.out" 2> "$tmp/rust-pty.err" &
    client_pids="$client_pids $!"
    n=0
    until grep -q '^pty ' "$tmp/node-pty.out" && grep -q '^pty ' "$tmp/rust-pty.out"; do
      if [ "$n" -ge 150 ]; then
        echo "measure.sh: a pty did not open within 15 s:" >&2
        cat "$tmp/node-pty.err" "$tmp/rust-pty.err" >&2
        exit 1
      fi
      sleep 0.1
      n=$((n + 1))
    done
    node_pty_id=$(cut -d' ' -f2 "$tmp/node-pty.out")
    rust_pty_id=$(cut -d' ' -f2 "$tmp/rust-pty.out")
    echo "# ptys open: node $node_pty_id rust $rust_pty_id, each running: while :; do date; sleep 1; done"
    state=pty
  fi
  minute=$((minute + 1))
done

echo
echo "Measured on $(uname -m), $cores cores, $mem_mb MB, $(uname -sr). Node daemon pid $node_pid ($node_source), hello version ${node_hello%% *}. Rust daemon $bin_bytes bytes on disk ($linkage), hello version ${rust_hello%% *}, $ready. daemon kB is the daemon's own VmRSS; total kB adds every process under it (the pty's shell and its sleep), about 4 MB of dash and sleep under each in the pty state. Once a minute; the pty state is one shell per daemon printing a line a second."
echo
echo "Node daemon"
echo
echo "| minute | state | daemon kB | total kB | pids counted |"
echo "|---|---|---|---|---|"
while IFS='|' read -r m ndk ntk rdk rtk st np rp; do
  echo "| $m | $st | $ndk | $ntk | $np |"
done < "$tmp/rows"
echo
echo "Rust daemon"
echo
echo "| minute | state | daemon kB | total kB | pids counted |"
echo "|---|---|---|---|---|"
while IFS='|' read -r m ndk ntk rdk rtk st np rp; do
  echo "| $m | $st | $rdk | $rtk | $rp |"
done < "$tmp/rows"
