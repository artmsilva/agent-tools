import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolspaceServer } from "./server.mjs";

async function withServer(callback) {
  const root = mkdtempSync(join(tmpdir(), "pi-toolspace-server-"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public", "index.html"), "<h1>Toolspace</h1>");
  writeFileSync(join(root, "private.txt"), "private");
  const server = createToolspaceServer({ root, home: root });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("serves the dashboard and blocks paths outside public", async () => {
  await withServer(async (baseUrl) => {
    const dashboard = await fetch(`${baseUrl}/`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Toolspace/);

    const privateFile = await fetch(`${baseUrl}/%2e%2e/private.txt`);
    assert.equal(privateFile.status, 404);
  });
});
