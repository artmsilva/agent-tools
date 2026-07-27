#!/bin/sh
cleanup() { rm -f /run/pi-drydock/status/pi-state; }
trap cleanup EXIT

PI_REAL=/usr/local/bin/pi-real
[ -x "$PI_REAL" ] || PI_REAL=/usr/local/bin/pi

"$PI_REAL" \
  -e /run/pi-drydock/pi-provider.ts \
  -e /run/pi-drydock/herdr-state.ts \
  --provider drydock-anthropic \
  --model claude-haiku-4-5 \
  --session-dir /home/node/.pi/agent/sessions \
  "$@"
