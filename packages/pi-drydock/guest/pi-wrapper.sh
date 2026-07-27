#!/bin/sh
cleanup() { rm -f /run/pi-drydock/status/pi-state; }
trap cleanup EXIT

PI_REAL=/usr/local/bin/pi-real
[ -x "$PI_REAL" ] || PI_REAL=/usr/local/bin/pi

if [ -f /run/pi-drydock/default-model ]; then
  { IFS= read -r PROVIDER; IFS= read -r MODEL; } < /run/pi-drydock/default-model
  set -- --provider "$PROVIDER" --model "$MODEL" "$@"
fi

"$PI_REAL" \
  -e /run/pi-drydock/pi-provider.ts \
  -e /run/pi-drydock/herdr-state.ts \
  --session-dir /home/node/.pi/agent/sessions \
  "$@"
