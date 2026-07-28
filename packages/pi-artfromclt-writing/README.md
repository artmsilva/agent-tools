# pi-artfromclt-writing

Personal Pi writing skill: preserve truth and voice, then make prose direct, compact, and intentional. It draws on Orwell-inspired clarity, Caveman's terse wrapper style, and Ponytail's insistence that every section earn its place.

## Install

```sh
pi install /path/to/agent-tools/packages/pi-artfromclt-writing
```

Restart Pi to load the package in a fresh session.

## Trigger

The `artfromclt-writing` skill loads when the user asks for artfromclt style, clearer, plainer, more direct, or concise prose, or a final clarity pass. It also supports precise technical instructions. It does not load for generic writing requests.

## Evaluation

```sh
npm run eval       # static contract and fixture checks
npm run eval:live  # runs six behavior cases through Pi
```

Live cases check technical precision, creative voice, consistent terms, concise status copy, preserved safety detail, and no unsolicited editorial commentary.

## Coordination

- Domain skills (`ux-copy`, `blog-writing-guide`, `humanize-writing`) lead when applicable.
- Caveman controls agent wrapper text, not the requested deliverable.
- Ponytail controls implementation scope, not prose voice.

## License

MIT — see [LICENSE](./LICENSE).
