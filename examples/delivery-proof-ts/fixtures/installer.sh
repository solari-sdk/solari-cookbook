#!/bin/sh
# Synthetic installer fixture. Stands in for a real project's install script:
# it drops a "binary" (a shell script — a real one would be compiled), writes
# a config file, and leaves a start command behind. Nothing here depends on
# any particular target software — swap this file, and delivery.yaml's
# deliver/expect sections, for your own installer and contract.
set -eu

BIN_DIR=/opt/widgetd/bin
CONFIG_DIR=/etc/widgetd
DATA_DIR=/var/lib/widgetd

mkdir -p "$BIN_DIR" "$CONFIG_DIR" "$DATA_DIR"

cat > "$BIN_DIR/widgetd" <<'BINARY'
#!/bin/sh
set -eu
DEFAULT_PORT=8080
CONFIG=/etc/widgetd/widgetd.conf
case "${1:-}" in
  --version)
    echo "widgetd 1.0.0"
    ;;
  start)
    PORT=$DEFAULT_PORT
    DATA=/var/lib/widgetd
    if [ -f "$CONFIG" ]; then
      CONFIGURED_PORT=$(grep '^port=' "$CONFIG" | cut -d= -f2)
      [ -n "$CONFIGURED_PORT" ] && PORT=$CONFIGURED_PORT
      CONFIGURED_DATA=$(grep '^data_dir=' "$CONFIG" | cut -d= -f2)
      [ -n "$CONFIGURED_DATA" ] && DATA=$CONFIGURED_DATA
    fi
    nohup python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$DATA" \
      > /var/log/widgetd.log 2>&1 &
    echo "started on port $PORT"
    ;;
  *)
    echo "usage: widgetd [--version|start]" >&2
    exit 1
    ;;
esac
BINARY
chmod +x "$BIN_DIR/widgetd"

cat > "$CONFIG_DIR/widgetd.conf" <<'CONFIG'
port=8080
data_dir=/var/lib/widgetd
CONFIG

echo "<html><body>widgetd is running</body></html>" > "$DATA_DIR/index.html"

echo "installed widgetd to $BIN_DIR"
