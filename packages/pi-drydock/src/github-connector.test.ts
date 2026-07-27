import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approveGitHubReviewRequest,
  createHostGitHubConnector,
  getGitHubReviewRequest,
  listGitHubReviewRequests,
  rejectGitHubReviewRequest,
  type GitHubRunner,
} from "./github-connector.ts";

const drydockId = "00000000-0000-4000-8000-000000000001";
const repository = { host: "github.com" as const, owner: "artmsilva", name: "agent-tools" };

test("uses host gh auth for repository-bound reads without exposing a token", async () => {
  const calls: string[][] = [];
  const connector = createHostGitHubConnector({
    drydockId,
    repository,
    permissions: ["repo:read"],
    requestsDirectory: await requestsDirectory(),
    runGh: async (args) => {
      calls.push(args);
      return '{"nameWithOwner":"artmsilva/agent-tools"}\n';
    },
  });

  const response = await connector.handleRequest(request({ operation: "repo.view", jsonFields: ["nameWithOwner"] }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"nameWithOwner":"artmsilva/agent-tools"}\n');
  assert.deepEqual(calls, [["repo", "view", "artmsilva/agent-tools", "--json", "nameWithOwner"]]);
  assert.doesNotMatch(JSON.stringify(connector.policy), /token|authorization|hosts\.yml/i);

  const denied = await connector.handleRequest(request({ operation: "issue.comment", number: 1, body: "hello" }));
  assert.equal(denied.status, 403);
});

test("queues GitHub writes for one-time host approval or rejection", async () => {
  const directory = await requestsDirectory();
  const calls: string[][] = [];
  const runGh: GitHubRunner = async (args) => {
    calls.push(args);
    return "https://github.com/artmsilva/agent-tools/issues/7#issuecomment-1\n";
  };
  const connector = createHostGitHubConnector({
    drydockId,
    repository,
    permissions: ["repo:read", "issues:comment:request"],
    requestsDirectory: directory,
    runGh,
  });

  const queuedResponse = await connector.handleRequest(request({ operation: "issue.comment", number: 7, body: "review me" }));
  assert.equal(queuedResponse.status, 200);
  const queued = await queuedResponse.json() as { id: string; status: string };
  assert.equal(queued.status, "pending");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, `${queued.id}.pending.json`))).mode & 0o777, 0o600);
  assert.deepEqual(calls, []);

  const store = { drydockId, repository, requestsDirectory: directory, runGh };
  assert.equal((await listGitHubReviewRequests(store)).length, 1);
  assert.equal((await getGitHubReviewRequest(store, queued.id)).input.body, "review me");
  const approved = await approveGitHubReviewRequest(store, queued.id);
  assert.equal(approved.status, "approved");
  assert.deepEqual(calls, [[
    "issue",
    "comment",
    "7",
    "--repo",
    "artmsilva/agent-tools",
    "--body",
    "review me",
  ]]);
  await assert.rejects(approveGitHubReviewRequest(store, queued.id), /not pending/);

  const secondResponse = await connector.handleRequest(request({ operation: "issue.comment", number: 8, body: "reject me" }));
  const second = await secondResponse.json() as { id: string };
  assert.equal((await rejectGitHubReviewRequest(store, second.id)).status, "rejected");
  assert.equal(calls.length, 1);
});

test("fails closed when review scope does not match the approving Drydock", async () => {
  const directory = await requestsDirectory();
  const connector = createHostGitHubConnector({
    drydockId,
    repository,
    permissions: ["issues:comment:request"],
    requestsDirectory: directory,
    runGh: async () => "",
  });
  const response = await connector.handleRequest(request({ operation: "issue.comment", number: 9, body: "scoped" }));
  const queued = await response.json() as { id: string };
  let calls = 0;

  await assert.rejects(approveGitHubReviewRequest({
    drydockId,
    repository: { ...repository, name: "other" },
    requestsDirectory: directory,
    runGh: async () => {
      calls += 1;
      return "";
    },
  }, queued.id), /repository mismatch/);
  assert.equal(calls, 0);
  assert.equal((await getGitHubReviewRequest({ drydockId, repository, requestsDirectory: directory }, queued.id)).status, "pending");
});

test("does not retry a reviewed write after host gh reports failure", async () => {
  const directory = await requestsDirectory();
  const connector = createHostGitHubConnector({
    drydockId,
    repository,
    permissions: ["issues:comment:request"],
    requestsDirectory: directory,
    runGh: async () => { throw new Error("ambiguous host failure"); },
  });
  const response = await connector.handleRequest(request({ operation: "issue.comment", number: 9, body: "once" }));
  const queued = await response.json() as { id: string };
  const store = {
    drydockId,
    repository,
    requestsDirectory: directory,
    runGh: async () => { throw new Error("ambiguous host failure"); },
  };

  await assert.rejects(approveGitHubReviewRequest(store, queued.id), /ambiguous host failure/);
  assert.equal((await getGitHubReviewRequest(store, queued.id)).status, "failed");
  await assert.rejects(approveGitHubReviewRequest(store, queued.id), /not pending/);
});

test("bounds the Guest-controlled pending review queue", async () => {
  const directory = await requestsDirectory();
  const connector = createHostGitHubConnector({
    drydockId,
    repository,
    permissions: ["issues:comment:request"],
    requestsDirectory: directory,
    runGh: async () => "",
  });
  for (let number = 1; number <= 100; number += 1) {
    const response = await connector.handleRequest(request({ operation: "issue.comment", number, body: "bounded" }));
    assert.equal(response.status, 200);
  }
  const denied = await connector.handleRequest(request({ operation: "issue.comment", number: 101, body: "too many" }));
  assert.equal(denied.status, 429);
  assert.equal((await listGitHubReviewRequests({ drydockId, repository, requestsDirectory: directory })).length, 100);
});

test("denies arbitrary GitHub operations and fields", async () => {
  const connector = createHostGitHubConnector({
    drydockId,
    repository,
    permissions: ["repo:read"],
    requestsDirectory: await requestsDirectory(),
    runGh: async () => "",
  });
  assert.equal((await connector.handleRequest(request({ operation: "auth.token" }))).status, 403);
  assert.equal((await connector.handleRequest(request({ operation: "repo.view", jsonFields: ["secretField"] }))).status, 403);
});

function request(body: unknown) {
  return {
    method: "POST",
    path: "/github",
    signal: new AbortController().signal,
    body: Buffer.from(JSON.stringify(body)),
  };
}

function requestsDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-drydock-github-requests-"));
}
