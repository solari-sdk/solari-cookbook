#!/bin/sh
# Deliberately broken variant of installer.sh: the config lands under the
# wrong filename, and a leftover debug copy of the binary ships alongside
# the real one. widgetd falls back to its default port when no config is
# found, so the service still comes up — "it works" and "it delivered
# exactly what it declared" are two different questions, and only the
# tree-inventory probe catches the second one.
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

# BUG: wrong filename — delivery.yaml's file probe looks for widgetd.conf.
cat > "$CONFIG_DIR/widgetd.conf.bak" <<'CONFIG'
port=8080
data_dir=/var/lib/widgetd
CONFIG

# BUG: a leftover debug build nobody meant to ship — an undeclared path
# under the tree probe's root.
cp "$BIN_DIR/widgetd" "$BIN_DIR/widgetd.debug"

echo "<html><body>widgetd is running</body></html>" > "$DATA_DIR/index.html"

echo "installed widgetd to $BIN_DIR"
