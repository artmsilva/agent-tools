#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-pi-drydock-pi:latest}"
BUILD_DNS="${DRYDOCK_BUILD_DNS:-1.1.1.1}"

container build \
  --platform linux/arm64 \
  --dns "$BUILD_DNS" \
  --tag "$IMAGE" \
  "$PACKAGE_DIR/image"

printf 'Built %s\n' "$IMAGE"
