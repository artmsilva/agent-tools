#!/usr/bin/env bash
# Bake the full pi-gondolin toolchain into a properly-sized guest image, then
# print how to use it. This is the recommended path for the complete zsh/
# starship experience — the stock image's rootfs is too small for it.
#
#   ./scripts/build-image.sh            # tag pi-gondolin:latest
#   ./scripts/build-image.sh --browser  # also bake chromium; tag pi-gondolin-browser:latest
#
# Requires: QEMU, and a container runtime (docker/podman) for Alpine rootfs
# assembly on macOS.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$PKG_DIR/image/build.jsonc"
TAG="pi-gondolin:latest"
BROWSER=0
for arg in "$@"; do
  case "$arg" in
    --browser) BROWSER=1; TAG="pi-gondolin-browser:latest" ;;
    *:*) TAG="$arg" ;;
  esac
done

if command -v gondolin >/dev/null 2>&1; then
  GONDOLIN=(gondolin)
else
  GONDOLIN=(npx --yes @earendil-works/gondolin)
fi

# The build CLI wants strict JSON; strip // comments (and add browser packages
# when requested) into a temp config.
BUILD_CONFIG="$(mktemp -t gondolin-build).json"
trap 'rm -f "$BUILD_CONFIG"' EXIT
node -e '
  const fs = require("fs");
  const strip = s => s.replace(/^\s*\/\/.*$/gm, "");
  const cfg = JSON.parse(strip(fs.readFileSync(process.argv[1], "utf8")));
  if (process.argv[3] === "1") {
    cfg.rootfs = { ...(cfg.rootfs || {}), sizeMb: 4096 };
    const extra = ["chromium","chromium-chromedriver","nss","freetype","harfbuzz","ttf-freefont","font-noto","dbus","udev"];
    cfg.alpine.rootfsPackages = [...new Set([...(cfg.alpine.rootfsPackages || []), ...extra])];
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(cfg, null, 2));
' "$CONFIG" "$BUILD_CONFIG" "$BROWSER"

[ "$BROWSER" = "1" ] && echo "Browser image: added chromium packages, rootfs 4096MB."
echo "Building Gondolin image -> tag '$TAG' (this takes a few minutes)…"
"${GONDOLIN[@]}" build --config "$BUILD_CONFIG" --tag "$TAG"

cat <<EOF

✓ Built and tagged '$TAG' in the local image store.

The pi-gondolin extension auto-detects this image and boots from it — no env var
needed. (To force a specific image: export GONDOLIN_DEFAULT_IMAGE=$TAG)

Smoke test:
    gondolin bash --image $TAG -- zsh -ic 'echo \$ZSH_VERSION; command -v starship rg git'
EOF
