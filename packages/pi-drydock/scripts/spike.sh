#!/usr/bin/env bash
# pi-drydock boundary spike — proves Apple container can isolate a copied file
# and return a host-reviewable patch without mounting the source workspace.
set -euo pipefail

IMAGE="docker.io/library/alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40"
RUN_ID="$(date +%s)-$$"
NAME="pi-drydock-spike-$RUN_ID"
NETWORK="pi-drydock-internal-$RUN_ID"
RESULT_DIR="$(mktemp -d /tmp/pi-drydock-spike.XXXXXX)"

command -v container >/dev/null || { echo "container is required: https://github.com/apple/container" >&2; exit 1; }
container system status >/dev/null || { echo "run: container system start" >&2; exit 1; }

mkdir -p "$RESULT_DIR/source" "$RESULT_DIR/export" "$RESULT_DIR/apply"
printf 'status=original\n' > "$RESULT_DIR/source/message.txt"
cp "$RESULT_DIR/source/message.txt" "$RESULT_DIR/apply/message.txt"
BEFORE="$(shasum -a 256 "$RESULT_DIR/source/message.txt" | cut -d' ' -f1)"

cleanup() {
  container delete --force "$NAME" >/dev/null 2>&1 || true
  container network delete "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

container network create --internal "$NETWORK" >/dev/null
container create \
  --name "$NAME" \
  --cpus 1 \
  --memory 512M \
  --uid 65534 \
  --gid 65534 \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp \
  --tmpfs /workspace \
  --network "$NETWORK" \
  --no-dns \
  "$IMAGE" \
  /bin/sleep 300 >/dev/null
container start "$NAME" >/dev/null

# `container copy` writes beneath the live tmpfs mount. Stream into the mounted
# filesystem instead, as the same unprivileged UID that edits the workspace.
container exec --interactive --uid 65534 --gid 65534 "$NAME" \
  /bin/sh -c 'cat > /workspace/message.txt' < "$RESULT_DIR/source/message.txt"

# The nested guest shell expands these expressions, not this host script.
# shellcheck disable=SC2016
GUEST_RESULT="$(container exec --workdir /workspace "$NAME" /bin/sh -lc '
  test "$(id -u)" = 65534
  test "$(id -g)" = 65534
  test ! -e /Users
  cp message.txt message.txt.orig
  printf "status=edited-in-guest\n" > message.txt
  diff -u message.txt.orig message.txt | sed "1s/message.txt.orig/message.txt/" > /tmp/change.patch || test "$?" -eq 1
  if wget -T 3 -O /tmp/egress.out http://1.1.1.1 >/tmp/egress.log 2>&1; then
    exit 20
  fi
  printf "uid=65534 host_home=hidden egress=blocked"
')"

if container exec --uid 0 --gid 0 "$NAME" /bin/touch /drydock-root-write >/dev/null 2>&1; then
  echo "FAIL: root filesystem is writable" >&2
  exit 1
fi

container exec "$NAME" /bin/cat /tmp/change.patch > "$RESULT_DIR/export/change.patch"
AFTER="$(shasum -a 256 "$RESULT_DIR/source/message.txt" | cut -d' ' -f1)"
test "$BEFORE" = "$AFTER"
patch -s -d "$RESULT_DIR/apply" -p0 < "$RESULT_DIR/export/change.patch"
grep -q '^status=edited-in-guest$' "$RESULT_DIR/apply/message.txt"

printf '%s\n' \
  "PASS: $GUEST_RESULT rootfs=read_only source_unchanged=yes patch_applies=yes" \
  "Patch: $RESULT_DIR/export/change.patch" \
  "Results retained at: $RESULT_DIR"
