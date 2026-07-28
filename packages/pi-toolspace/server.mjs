import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { scanToolspace } from "./scanner.mjs";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function createToolspaceServer({ root, home } = {}) {
  const publicDir = join(root, "public");
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/snapshot") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(scanToolspace({ home })));
      return;
    }

    const requestedPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = resolve(publicDir, requestedPath);
    if (relative(publicDir, path).startsWith("..") || !existsSync(path)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME_TYPES[extname(path)] ?? "application/octet-stream" });
    createReadStream(path).pipe(response);
  });
}
