# pi-tripwire

Pi extension that redacts secrets from tool results before they enter model context.

## What it does

Hooks into `tool_result` events and scans **outbound text content** for secrets, replacing them with `[TRIPWIRE:<type>]` markers. Only text blocks are scanned; images are left untouched.

## Installation

```bash
pi install github:artmsilva/agent-tools/packages/pi-tripwire
```

Or for local development:

```bash
ln -s /path/to/agent-tools/packages/pi-tripwire ~/.pi/agent/extensions/pi-tripwire
```

## Usage

Once installed, pi-tripwire activates automatically. No configuration needed.

To see redaction statistics for the current session:

```
/tripwire
```

## What gets redacted

| Type | Pattern | Example |
|------|---------|---------|
| GitHub tokens | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` | `ghp_abc123...` |
| Slack tokens | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-` | `xoxb-1234-5678-abc` |
| AWS access keys | `AKIA[0-9A-Z]{16}` | `AKIAIOSFODNN7EXAMPLE` |
| AWS secret keys | `aws_secret_access_key` context | `aws_secret_access_key: wJalr...` |
| OpenAI keys | `sk-[A-Za-z0-9_-]{20,}` | `sk-abc123...` |
| Anthropic keys | `sk-ant-[A-Za-z0-9_-]{20,}` | `sk-ant-api03-...` |
| JWTs | `eyJ...eyJ...` | `eyJhbGci...` |
| PEM private keys | `-----BEGIN PRIVATE KEY-----` | Full PEM block |
| Bearer tokens | `Authorization: Bearer ...` | Prefix preserved |
| npm tokens | `npm_[A-Za-z0-9]{36}` | `npm_abc123...` |

## What does NOT get redacted

- **1Password references**: `op://vault/item/field` — these are safe pointers, not secrets
- **Base64 data**: Ordinary base64 strings (e.g., image data, compressed payloads)
- **SHA hashes**: Git commit hashes, file checksums
- **UUIDs**: Standard UUIDs
- **Normal prose**: English text, log messages

No generic entropy detection by default (too many false positives on base64 assets and hashes).

## Why this matters

You load secrets via `op inject`, use GitHub/Slack/AWS/OpenAI tokens, and run tools that might echo those secrets back (e.g., `env`, `cat ~/.config/...`, error messages). Without pi-tripwire, those secrets enter model context verbatim and can:

- Leak to provider logs
- Appear in session transcripts
- Get cached in prompt caches
- Be repeated back by the model

pi-tripwire redacts them **before** they hit model context, not after.

## Implementation

- **Single pass per pattern**: Precompiled regexes
- **Zero runtime dependencies**: Pure TypeScript
- **Type-safe**: No `any` types
- **Text-only**: Leaves image blocks untouched
- **Pure function**: Exported `redact(text)` for testing

## Example

```typescript
import { redact } from "pi-tripwire";

const input = "Token: ghp_abc123, Slack: xoxb-1234-5678";
const { text, hits } = redact(input);

console.log(text);
// => "Token: [TRIPWIRE:github-token], Slack: [TRIPWIRE:slack-token]"

console.log(hits);
// => { "github-token": 1, "slack-token": 1 }
```

## License

MIT — see [LICENSE](./LICENSE)
