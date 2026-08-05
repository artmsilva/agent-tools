# pi-tavily-native

Zero-dependency adaptation of Tavily's official Pi extension. Uses Node's native `fetch`; no Tavily SDK, Axios, or multipart dependency chain. Tavily remains the original author and service provider.

## Tools

- `tavily_search` — Tavily Search with depth, topic, date, domain, country, answer, raw-content, image, and usage options.
- `tavily_fetch` — Tavily Extract for up to 20 URLs, with optional query-focused chunks.

Large responses are truncated using Pi's built-in limits and saved to a temporary JSON file.

## Authentication

```bash
export TAVILY_API_KEY=tvly-...
```

## Install

```bash
pi install /path/to/agent-tools/packages/pi-tavily
```

Then restart Pi or run `/reload`.

## Validation

```bash
npm test
```

## Attribution

Adapted from the public tool contract of Tavily's official `@tavily/pi-extension`. Upstream attribution is preserved; this private package does not relicense Tavily's work.
