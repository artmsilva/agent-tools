#!/bin/sh
exec /usr/local/bin/pi-real \
  -e /run/pi-drydock/pi-provider.ts \
  --provider drydock-anthropic \
  --model claude-haiku-4-5 \
  --session-dir /home/node/.pi/agent/sessions \
  "$@"
