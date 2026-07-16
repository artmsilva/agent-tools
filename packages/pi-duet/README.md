# pi-duet

Instant second opinion from a cheap model. On `alt+u` or `/duet [prompt]`, send a prompt to a second cheap model in the background and show the answer in a side overlay without disturbing the main conversation.

## Usage

### Keybinding

Press `alt+u` to get a second opinion on the last user message in your session.

### Command

```
/duet <optional text>
```

If text is provided, duet that text. Otherwise, duet the last user message.

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

The prompt sent to the duet model includes:
- Current working directory
- The user's message only (NOT the full session history)

This keeps duet calls cheap and fast. The second opinion is based only on the question, not the entire conversation context.

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
