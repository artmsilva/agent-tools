# Fork notice

This directory is a modified fork of [mksglu/context-mode](https://github.com/mksglu/context-mode), imported from upstream commit `b6f25a6` on 2026-07-17.

Modifications by Art Silva / agent-tools:

- Handle errors emitted by the Pi MCP bridge child's stdin stream so a closed pipe cannot terminate Pi with an uncaught `EPIPE`.
- Add a real child-process regression test for that failure mode.

Upstream copyright and notices remain intact. This fork remains licensed under the [Elastic License 2.0](./LICENSE), not agent-tools' root MIT license.
