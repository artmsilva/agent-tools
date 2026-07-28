#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createToolspaceServer } from "./server.mjs";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex === -1 ? 4288 : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Usage: pi-toolspace [--port 4288]");
  process.exit(1);
}

const root = dirname(fileURLToPath(import.meta.url));
const server = createToolspaceServer({ root, home: homedir() });
server.listen(port, "127.0.0.1", () => {
  console.log(`Toolspace → http://127.0.0.1:${port}`);
});
