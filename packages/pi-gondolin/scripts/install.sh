#!/usr/bin/env bash
# Install pi-gondolin as a pi extension by symlinking it into
# ~/.pi/agent/extensions/gondolin and installing its dependencies.
#
#   ./scripts/install.sh
#
# Idempotent. Backs up any existing non-symlink extension dir once.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
LINK="$EXT_DIR/gondolin"

echo "pi-gondolin package: $PKG_DIR"

# --- prerequisites --------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ node not found (need >= 23.6)." >&2; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 23 ]; then
  echo "✗ node $NODE_MAJOR is too old; Gondolin needs >= 23.6." >&2; exit 1
fi

if command -v qemu-system-aarch64 >/dev/null 2>&1 || command -v qemu-system-x86_64 >/dev/null 2>&1; then
  echo "✓ QEMU present."
else
  echo "! QEMU not found. Install it: 'brew install qemu' (macOS) / 'apt install qemu-system' (Linux)." >&2
fi

# --- deps -----------------------------------------------------------------
echo "Installing dependencies (npm install --ignore-scripts)…"
( cd "$PKG_DIR" && npm install --ignore-scripts )

# --- symlink into pi extensions ------------------------------------------
mkdir -p "$EXT_DIR"
if [ -L "$LINK" ]; then
  rm -f "$LINK"
elif [ -e "$LINK" ]; then
  # Back up OUTSIDE the extensions dir — a backup left inside it would be loaded
  # by pi too and collide (duplicate read/write/bash/... tools).
  BACKUP_DIR="$(dirname "$EXT_DIR")/gondolin-backups"
  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/gondolin.bak-$(date +%Y%m%d%H%M%S)"
  echo "Backing up existing extension: $LINK -> $BACKUP"
  mv "$LINK" "$BACKUP"
fi
ln -sfn "$PKG_DIR" "$LINK"
echo "✓ Linked $LINK -> $PKG_DIR"

# --- bake the full-toolchain image (recommended) --------------------------
# The stock Gondolin rootfs is ~86MB free — too small for zsh+starship+node+etc.
# Bake a properly-sized image when a container runtime is available so the full
# experience works out of the box. Pass --no-image to skip.
SKIP_IMAGE=0
for a in "$@"; do [ "$a" = "--no-image" ] && SKIP_IMAGE=1; done

HAVE_IMAGE=0
if command -v gondolin >/dev/null 2>&1; then
  gondolin image ls 2>/dev/null | grep -q 'pi-gondolin:latest' && HAVE_IMAGE=1 || true
fi

if [ "$SKIP_IMAGE" = "0" ] && [ "$HAVE_IMAGE" = "0" ]; then
  if docker info >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then
    echo
    echo "Baking the full-toolchain image (pi-gondolin:latest) — a few minutes…"
    if "$PKG_DIR/scripts/build-image.sh"; then
      echo "✓ Image baked. The extension will auto-detect and boot from it."
    else
      echo "! Image build failed. You can retry: ./scripts/build-image.sh" >&2
      echo "  Without it, the sandbox still runs on the stock image with a minimal toolset." >&2
    fi
  else
    echo
    echo "! No container runtime (docker/podman) detected — skipping image bake."
    echo "  The sandbox runs on the stock image with a minimal toolset. For the full"
    echo "  zsh/starship toolchain, start a container runtime and run: ./scripts/build-image.sh"
  fi
fi

cat <<EOF

Done. The sandbox is OPT-IN — a normal 'pi' is unaffected. Enable per launch:

  pi --gondolin                 run pi's tools inside the micro-VM sandbox
  GONDOLIN=1 pi                 same, via env
  pi --gondolin --gondolin-browser   + in-VM browser (chromium + agent-browser)

Once enabled:
  /gondolin              show VM + sandbox status
  /gondolin-timing       boot timeline
  /gondolin-allowlist    view the egress allowlist
  /gondolin-allow HOST   permanently allow a host

Optional fast-boot image (bakes the toolchain):
  ./scripts/build-image.sh && export GONDOLIN_DEFAULT_IMAGE=pi-gondolin:latest
EOF
