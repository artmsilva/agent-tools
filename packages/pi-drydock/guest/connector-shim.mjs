#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.DRYDOCK_CONNECTOR_PORT ?? "43127", 10);
const pending = new Map();
let policy;

const server = createServer(handleHttpRequest);
createInterface({ input: process.stdin }).on("line", receiveFrame).on("close", shutdown);
server.listen(port, host);

async function handleHttpRequest(request, response) {
  try {
    if (servePolicy(request, response)) return;
    const activePolicy = requirePolicy();
    const body = await readRequestBody(request, activePolicy.maxRequestBytes);
    forwardToHost(request, response, body);
  } catch (error) {
    sendHttpError(response, error);
  }
}

function servePolicy(request, response) {
  if (!isPolicyRequest(request)) return false;
  response.writeHead(policy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify(policy ?? { error: "Connector policy unavailable" }));
  return true;
}

function isPolicyRequest(request) {
  return request.method === "GET" && request.url === "/.well-known/pi-drydock-connector";
}

function requirePolicy() {
  if (!policy) throw Object.assign(new Error("Connector unavailable"), { status: 503 });
  return policy;
}

function forwardToHost(request, response, body) {
  const id = randomUUID();
  pending.set(id, response);
  writeFrame({
    type: "request",
    id,
    method: request.method ?? "",
    path: request.url ?? "",
    headers: selectGuestHeaders(request.headers),
    body: body.toString("base64"),
  });
}

function sendHttpError(response, error) {
  response.writeHead(error.status ?? 400, { "content-type": "text/plain" });
  response.end(error instanceof Error ? error.message : "Connector request failed");
}

function receiveFrame(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    shutdown();
    return;
  }
  const handler = FRAME_HANDLERS[frame.type];
  if (handler) handler(frame);
}

const FRAME_HANDLERS = {
  policy(frame) {
    policy = Object.freeze(frame.policy);
  },
  "response-start"(frame) {
    pending.get(frame.id)?.writeHead(frame.status, frame.headers);
  },
  "response-chunk"(frame) {
    pending.get(frame.id)?.write(Buffer.from(frame.body, "base64"));
  },
  "response-end"(frame) {
    takeResponse(frame.id)?.end();
  },
  "response-error"(frame) {
    const response = takeResponse(frame.id);
    if (!response) return;
    if (response.headersSent) response.destroy(new Error(frame.message));
    else {
      response.writeHead(frame.status, { "content-type": "text/plain" });
      response.end(frame.message);
    }
  },
};

function takeResponse(id) {
  const response = pending.get(id);
  pending.delete(id);
  return response;
}

async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > maxBytes) throw Object.assign(new Error("Connector request limit exceeded"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function selectGuestHeaders(headers) {
  return typeof headers["content-type"] === "string" ? { "content-type": headers["content-type"] } : {};
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function shutdown() {
  for (const response of pending.values()) response.destroy(new Error("Connector closed"));
  pending.clear();
  server.close();
}
