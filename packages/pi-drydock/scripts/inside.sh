#!/usr/bin/env bash
set -euo pipefail

IMAGE="${DRYDOCK_INSIDE_IMAGE:-pi-drydock-pi:latest}"
NAME="${DRYDOCK_INSIDE_NAME:-pi-drydock-inside}"
NETWORK="${NAME}-net"
UID_GUEST=1000
GID_GUEST=1000

usage() {
  cat <<'EOF'
Usage: ./scripts/inside.sh <start|enter|patch|status|stop|smoke> [args]

  start          Copy the current Git workspace into a persistent guest.
  enter [args]   Run Pi inside the guest through container exec's TTY.
  patch          Print the cumulative guest text patch.
  status         Show the container status.
  stop           Delete the guest and its private network.
  smoke          Verify Pi, input forwarding, and the security boundary.
EOF
}

exists() {
  container inspect "$NAME" >/dev/null 2>&1
}

network_exists() {
  container network inspect "$NETWORK" >/dev/null 2>&1
}

assert_running() {
  if ! exists; then
    printf 'Drydock is not running. Run: ./scripts/inside.sh start\n' >&2
    exit 1
  fi
}

guest_exec() {
  container exec \
    --uid "$UID_GUEST" \
    --gid "$GID_GUEST" \
    --workdir /workspace \
    "$NAME" \
    /bin/setpriv --nnp --inh-caps=-all --ambient-caps=-all \
    "$@"
}

stop() {
  if exists; then container delete --force "$NAME" >/dev/null; fi
  if network_exists; then container network delete "$NETWORK" >/dev/null; fi
}

start() {
  if exists; then
    printf 'Drydock already exists: %s\n' "$NAME" >&2
    exit 1
  fi

  local root
  root="$(git -C "${DRYDOCK_WORKSPACE:-$PWD}" rev-parse --show-toplevel)"
  cleanup_failed_start() {
    local status=$?
    trap - ERR
    if ! stop; then printf 'Drydock startup cleanup failed\n' >&2; fi
    return "$status"
  }
  trap cleanup_failed_start ERR

  container network create --internal "$NETWORK" >/dev/null
  container create \
    --name "$NAME" \
    --uid 0 \
    --cpus 2 \
    --memory 2G \
    --cap-drop ALL \
    --cap-add CAP_CHOWN \
    --cap-add CAP_NET_ADMIN \
    --cap-add CAP_SETUID \
    --cap-add CAP_SETGID \
    --read-only \
    --tmpfs /tmp \
    --tmpfs /home/node \
    --tmpfs /baseline \
    --tmpfs /workspace \
    --network "$NETWORK" \
    --no-dns \
    --entrypoint /bin/sh \
    "$IMAGE" \
    -lc 'chown 1000:1000 /tmp /home/node /baseline /workspace; ip link set eth0 down; exec su node -s /bin/sh -c "exec sleep 86400"' >/dev/null
  container start "$NAME" >/dev/null

  git -C "$root" ls-files -z --cached \
    | tar -C "$root" --no-recursion --no-xattrs --no-acls --no-fflags --null -T - -cf - \
    | container exec --interactive --uid "$UID_GUEST" --gid "$GID_GUEST" "$NAME" \
      /bin/setpriv --nnp --inh-caps=-all --ambient-caps=-all \
      /bin/sh -lc 'tar -xf - -C /baseline && cp -R /baseline/. /workspace/ && cd /workspace && git init -q && git add -A && git -c user.name=Drydock -c user.email=drydock@invalid commit --allow-empty -qm baseline'

  guest_exec /bin/sh -lc \
    "set -e; test \"\$(cat /sys/class/net/eth0/operstate)\" = down; grep -q \"^NoNewPrivs:[[:space:]]*1\" /proc/self/status; ! ip link set eth0 up 2>/dev/null"

  trap - ERR
  printf 'Drydock ready: %s\nEnter with: ./scripts/inside.sh enter\n' "$NAME"
}

enter() {
  assert_running
  exec container exec \
    --interactive \
    --tty \
    --env "TERM=${TERM:-xterm-256color}" \
    --uid "$UID_GUEST" \
    --gid "$GID_GUEST" \
    --workdir /workspace \
    "$NAME" \
    /bin/setpriv --nnp --inh-caps=-all --ambient-caps=-all \
    pi "$@"
}

patch() {
  assert_running
  guest_exec /bin/sh -lc \
    "diff -ruN --exclude=.git /baseline /workspace > /tmp/raw.patch; code=\$?; [ \$code -le 1 ] || exit \$code; sed -e 's#^--- /baseline/#--- a/#' -e 's#^+++ /workspace/#+++ b/#' /tmp/raw.patch"
}

smoke() {
  start
  trap stop EXIT
  guest_exec /bin/sh -lc \
    "set -e; pi --version; test \"\$(id -u)\" = 1000; grep -q \"^NoNewPrivs:[[:space:]]*1\" /proc/self/status; grep -q \"^CapEff:[[:space:]]*0\{16\}\$\" /proc/self/status; grep -q \"^CapInh:[[:space:]]*0\{16\}\$\" /proc/self/status; grep -q \"^CapAmb:[[:space:]]*0\{16\}\$\" /proc/self/status; test \"\$(cat /sys/class/net/eth0/operstate)\" = down; test ! -e /home/node/.pi/agent/auth.json; ! ip link set eth0 up 2>/dev/null"
  printf 'host-input-ok\n' \
    | container exec --interactive --uid "$UID_GUEST" --gid "$GID_GUEST" "$NAME" \
      /bin/setpriv --nnp --inh-caps=-all --ambient-caps=-all \
      /bin/sh -lc "set -e; read -r line; test \"\$line\" = host-input-ok; printf '%s\\n' \"\$line\" > /workspace/input-proof.txt"
  [[ "$(guest_exec cat /workspace/input-proof.txt)" == host-input-ok ]]
  container exec --tty --uid "$UID_GUEST" --gid "$GID_GUEST" "$NAME" \
    /bin/setpriv --nnp --inh-caps=-all --ambient-caps=-all \
    /bin/sh -lc 'test -t 0'
  printf 'PASS: pi=inside tty=yes input_forwarded=yes uid=1000 no_new_privs=yes network=down host_auth=absent\n'
}

case "${1:-}" in
  start) start ;;
  enter) shift; enter "$@" ;;
  patch) patch ;;
  status) container inspect "$NAME" ;;
  stop) stop ;;
  smoke) smoke ;;
  *) usage; exit 1 ;;
esac
