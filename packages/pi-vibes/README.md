# pi-vibes

Ambient vibes for pi: soundtrack, mood ring, and familiar.

Three features sharing one internal event bus:

## Features

### 1. Soundtrack
Play macOS system sounds on tool events (no-op on non-darwin):
- **Glass** – tool completes after >10s
- **Basso** – tool error
- **Ping** – agent settled, needs input
- **Funk** – agent settled

Debounced: max 1 sound per 2 seconds.

### 2. Mood Ring
Colored dot (●) in footer reflecting rolling session health:
- **Green** – recent tools succeeding
- **Amber** – recent retries or slow tools (>10s)
- **Red** – error streak (2+ consecutive errors)
- **Purple** – tool currently running >15s

Computed from rolling window of last 10 tool results.

### 3. Familiar
Tiny animated creature in footer:
- **(o.o)** / **(-.-)**  – idle (blink every few seconds)
- **(o.o) (o_o) (O_O)** – running animation while tool executes
- **(x.x)** – faint on error
- **\\(^o^)/** – celebrate briefly after successful git commit

## Usage

```bash
# Install
pi install git:github.com/artmsilva/agent-tools/packages/pi-vibes

# Toggle features
/vibes                    # show status
/vibes sound off          # disable soundtrack
/vibes mood on            # enable mood ring
/vibes familiar off       # disable familiar

# Settings persist in ~/.pi/agent/vibes.json
```

## Sound Map

| Event | Sound | Trigger |
|-------|-------|---------|
| Long tool | Glass | Tool >10s |
| Error | Basso | Tool isError |
| Needs input | Ping | Agent settled |

## Implementation Notes

- **Mood + Familiar combined** into one footer status (`ctx.ui.setStatus("vibes", ...)`) since pi footer supports multiple status keys but they're all shown together
- **Animation timer** uses `setInterval(...).unref()` to not keep process alive
- **Sound spawns** use `{ detached: true, stdio: "ignore" }` and `.unref()` to never block
- **Settings** persist in `~/.pi/agent/vibes.json`

## License

MIT
