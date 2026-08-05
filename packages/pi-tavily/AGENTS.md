# Package instructions

## Scope

Zero-dependency Pi extension for Tavily Search and Extract using Node's native `fetch`.

## Validation

```bash
npm test
```

## Guardrails

- Keep runtime `dependencies` empty. Pi APIs and `typebox` remain peer dependencies.
- Never log or return `TAVILY_API_KEY`.
- Keep the public tools named `tavily_search` and `tavily_fetch` with snake_case parameters.
- `chunks_per_source` requires advanced search depth for search and `query` for fetch.
- Fetch accepts at most 20 URLs.
- Preserve Pi's output truncation and full-output temp-file fallback.
