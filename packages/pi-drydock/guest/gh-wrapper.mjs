#!/usr/bin/env node
// Apple container gives each Drydock its own VM network namespace; this loopback
// listener is created inside that Guest and dies with its host-owned Connector.
const CONNECTOR = "http://127.0.0.1:43127/github";

try {
  const args = process.argv.slice(2);
  if (args[0] === "auth" && args[1] === "status" && args.length === 2) {
    process.stdout.write("github.com: authenticated through the host Drydock Connector (token unavailable in Guest)\n");
    process.exit(0);
  }
  if (args[0] === "auth") deny("Guest GitHub credentials are unavailable");
  if (args[0] === "repo" && args[1] === "view") await repoView(args.slice(2));
  else if (args[0] === "issue" && args[1] === "comment") await issueComment(args.slice(2));
  else deny("Unsupported Drydock gh command");
} catch (error) {
  process.stderr.write(`gh: ${error instanceof Error ? error.message : "request failed"}\n`);
  process.exit(1);
}

async function repoView(args) {
  const jsonFields = parseRepoViewArgs(args);
  const body = jsonFields ? { operation: "repo.view", jsonFields } : { operation: "repo.view" };
  const response = await request(body);
  process.stdout.write(await response.text());
}

function parseRepoViewArgs(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2) deny("Only gh repo view --json <fields> is supported");
  if (args[0] !== "--json") deny("Only gh repo view --json <fields> is supported");
  return args[1].split(",").filter(Boolean);
}

async function issueComment(args) {
  const [number, body] = parseIssueCommentArgs(args);
  const response = await request({ operation: "issue.comment", number, body });
  const review = await response.json();
  process.stdout.write(`GitHub review request queued: ${review.id}\n`);
}

function parseIssueCommentArgs(args) {
  if (args.length !== 3) deny("Use: gh issue comment <number> --body <text>");
  if (!/^\d+$/.test(args[0])) deny("Use: gh issue comment <number> --body <text>");
  if (!["--body", "-b"].includes(args[1])) deny("Use: gh issue comment <number> --body <text>");
  return [Number(args[0]), args[2]];
}

async function request(body) {
  const response = await fetch(CONNECTOR, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return response;
  let message = `Connector returned ${response.status}`;
  try {
    const body = await response.json();
    if (typeof body.error === "string") message = body.error;
  } catch {}
  throw new Error(message);
}

function deny(message) {
  throw new Error(message);
}
