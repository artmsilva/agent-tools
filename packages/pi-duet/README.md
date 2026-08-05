# pi-duet

Side conversations that do not disturb the main session:

- `alt+u` or `/duet [prompt]` asks a cheap model for a context-free second opinion.
- `/btw <question>` asks the current model about the existing session without tools or transcript writes.

## Usage

### Keybinding

Press `alt+u` to get a second opinion on the last user message in your session.

### Command

```
/duet <optional text>
```

If text is provided, duet that text. Otherwise, duet the last user message.

### Ephemeral side question

```
/btw <question>
```

`/btw` replays the current session context to the active model, appends one tool-free side question, and shows the answer in a dismissible overlay. The question and answer are not added to the main transcript. If the session is between a tool call and its result, retry after that tool finishes.

## Configuration

### Model Selection

By default, pi-duet tries these models in order:
1. `anthropic/claude-haiku-4`
2. `anthropic/claude-3-5-haiku-20241022`
3. `openai/gpt-4o-mini`

Override with the `DUET_MODEL` environment variable:

```bash
export DUET_MODEL="openai/gpt-4o-mini"
pi
```

Format: `provider/modelId`

## Design

### LLM Call Method

This extension calls LLMs using the **`@earendil-works/pi-ai/compat` `complete()` API**. This is the recommended path for extensions:
- Type-safe
- Uses the same model registry and auth as the main session
- Supports abort signals for cancellation
- No subprocess overhead

Alternative approaches considered:
- **Subprocess via `pi --print`**: Would work but adds process spawn overhead and doesn't stream
- **Direct provider HTTP calls**: Would duplicate auth/model resolution logic

### Overlay UI

Results are shown using `ctx.ui.custom()` with a custom `DuetResultComponent`. The overlay:
- Shows model name and latency in the header
- Wraps long text to fit the 80-column width
- Dismisses on any keypress (Esc or any other key)

### Abort

While the duet model is running, press Esc to cancel. This is handled via `AbortSignal` passed to `complete()`.

### Context Isolation

`/duet` receives only the working directory and question, keeping second opinions cheap. `/btw` receives the current session context but no tools; it uses the active model, system prompt, session ID, and short cache retention so providers can reuse the main prompt prefix.

The `/btw` behavior was informed by [Fatih0234/btw](https://github.com/Fatih0234/btw); this implementation reuses pi-duet's existing model-call and overlay path.

## Installation

Add to your pi extensions:

```bash
# Global
ln -s /Users/asilva/Github/agent-tools/packages/pi-duet ~/.pi/agent/extensions/pi-duet

# Project-local
ln -s /Users/asilva/Github/agent-tools/packages/pi-duet .pi/extensions/pi-duet
```

Or via package.json:

```json
{
  "pi": {
    "extensions": ["./path/to/pi-duet"]
  }
}
```

## License

MIT
