#!/usr/bin/env bash
# pi-drydock boundary spike — proves Apple container can isolate a copied file
# and return a host-reviewable patch without mounting the source workspace.
set -euo pipefail

IMAGE="docker.io/library/alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40"
RUN_ID="$(date +%s)-$$"
NAME="pi-drydock-spike-$RUN_ID"
NETWORK="pi-drydock-internal-$RUN_ID"
RESULT_DIR="$(mktemp -d /tmp/pi-drydock-spike.XXXXXX)"
HOST_PORT=$((40000 + $$ % 20000))

command -v container >/dev/null || { echo "container is required: https://github.com/apple/container" >&2; exit 1; }
container system status >/dev/null || { echo "run: container system start" >&2; exit 1; }

mkdir -p "$RESULT_DIR/source" "$RESULT_DIR/export" "$RESULT_DIR/apply"
printf 'status=original\n' > "$RESULT_DIR/source/message.txt"
printf 'host-gateway-reachable\n' > "$RESULT_DIR/host-probe.txt"
cp "$RESULT_DIR/source/message.txt" "$RESULT_DIR/apply/message.txt"
BEFORE="$(shasum -a 256 "$RESULT_DIR/source/message.txt" | cut -d' ' -f1)"

python3 -m http.server "$HOST_PORT" --bind 0.0.0.0 --directory "$RESULT_DIR" \
  > "$RESULT_DIR/host-server.log" 2>&1 &
HOST_SERVER_PID=$!
sleep 0.2
kill -0 "$HOST_SERVER_PID" 2>/dev/null || { echo "failed to start host gateway probe server" >&2; exit 1; }

cleanup() {
  kill "$HOST_SERVER_PID" >/dev/null 2>&1 || true
  container delete --force "$NAME" >/dev/null 2>&1 || true
  container network delete "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

container network create --internal "$NETWORK" >/dev/null
# The guest bootstrap expands route variables after launch.
# shellcheck disable=SC2016
container create \
  --name "$NAME" \
  --cpus 1 \
  --memory 512M \
  --cap-drop ALL \
  --cap-add CAP_NET_ADMIN \
  --cap-add CAP_SETUID \
  --cap-add CAP_SETGID \
  --read-only \
  --tmpfs /tmp \
  --tmpfs /workspace \
  --network "$NETWORK" \
  --no-dns \
  "$IMAGE" \
  /bin/sh -lc \
  'gateway=$(ip route | awk '\''/^default/ {print $3; exit}'\''); printf "%s" "$gateway" > /tmp/host-gateway; ip link set eth0 down; exec su nobody -s /bin/sh -c "exec sleep 300"' \
  >/dev/null
container start "$NAME" >/dev/null

# `container copy` writes beneath the live tmpfs mount. Stream into the mounted
# filesystem instead, as the same unprivileged UID that edits the workspace.
container exec --interactive --uid 65534 --gid 65534 "$NAME" \
  /bin/setpriv --nnp --inh-caps '' --ambient-caps '' \
  /bin/sh -c 'cat > /workspace/message.txt' < "$RESULT_DIR/source/message.txt"

# The nested guest shell expands these expressions, not this host script.
# shellcheck disable=SC2016
GUEST_RESULT="$(container exec --uid 65534 --gid 65534 --workdir /workspace \
  --env "DRYDOCK_HOST_PORT=$HOST_PORT" "$NAME" \
  /bin/setpriv --nnp --inh-caps '' --ambient-caps '' /bin/sh -lc '
  test "$(id -u)" = 65534
  test "$(id -g)" = 65534
  test ! -e /Users
  grep -q "^NoNewPrivs:[[:space:]]*1" /proc/self/status
  test "$(cat /sys/class/net/eth0/operstate)" = down
  ! ip link set eth0 up 2>/dev/null
  gateway=$(cat /tmp/host-gateway)
  ! wget -q -T 3 -O /tmp/host.out "http://$gateway:$DRYDOCK_HOST_PORT/host-probe.txt" 2>/dev/null
  ! wget -q -T 3 -O /tmp/egress.out http://1.1.1.1 2>/dev/null
  cp message.txt message.txt.orig
  printf "status=edited-in-guest\n" > message.txt
  diff -u message.txt.orig message.txt | sed "1s/message.txt.orig/message.txt/" > /tmp/change.patch || test "$?" -eq 1
  printf "uid=65534 no_new_privs=yes host_home=hidden host_gateway=blocked egress=blocked network_restore=denied"
')"

if container exec --uid 0 --gid 0 "$NAME" /bin/touch /drydock-root-write >/dev/null 2>&1; then
  echo "FAIL: root filesystem is writable" >&2
  exit 1
fi

container exec --uid 65534 --gid 65534 "$NAME" \
  /bin/setpriv --nnp --inh-caps '' --ambient-caps '' \
  /bin/cat /tmp/change.patch > "$RESULT_DIR/export/change.patch"
AFTER="$(shasum -a 256 "$RESULT_DIR/source/message.txt" | cut -d' ' -f1)"
test "$BEFORE" = "$AFTER"
patch -s -d "$RESULT_DIR/apply" -p0 < "$RESULT_DIR/export/change.patch"
grep -q '^status=edited-in-guest$' "$RESULT_DIR/apply/message.txt"

printf '%s\n' \
  "PASS: $GUEST_RESULT rootfs=read_only source_unchanged=yes patch_applies=yes" \
  "Patch: $RESULT_DIR/export/change.patch" \
  "Results retained at: $RESULT_DIR"
