#!/usr/bin/env node

import { runDrydockCli } from "./src/cli.ts";

const abort = new AbortController();
process.once("SIGHUP", () => abort.abort());
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());

try {
  process.exitCode = await runDrydockCli(process.argv.slice(2), { signal: abort.signal });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
