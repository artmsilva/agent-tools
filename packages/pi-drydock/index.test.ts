import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCreateArgs,
  buildGuestShellArgs,
  buildTarArgs,
  DRYDOCK_IMAGE,
  renderDrydockResult,
} from "./src/drydock.ts";

test("create args enforce the Drydock boundary", () => {
  const args = buildCreateArgs("job", "isolated");
  assert.equal(args[0], "create");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--no-dns"));
  assert.ok(args.includes("CAP_NET_ADMIN"));
  assert.ok(args.includes("CAP_SETUID"));
  assert.ok(args.includes("CAP_SETGID"));
  assert.ok(args.includes("/baseline"));
  assert.ok(args.includes("/workspace"));
  assert.ok(args.includes("isolated"));
  assert.ok(args.includes(DRYDOCK_IMAGE));
  assert.match(args.at(-1) ?? "", /ip link set eth0 down/);
  assert.match(args.at(-1) ?? "", /su nobody/);
});

test("guest shell cannot gain bootstrap capabilities", () => {
  const args = buildGuestShellArgs("echo safe");
  assert.deepEqual(args.slice(0, 6), ["/bin/setpriv", "--nnp", "--inh-caps", "", "--ambient-caps", ""]);
  assert.deepEqual(args.slice(-3), ["/bin/sh", "-lc", "echo safe"]);
});

test("workspace tar reads tracked paths without recursing into submodules", () => {
  assert.deepEqual(buildTarArgs("/repo"), [
    "-C",
    "/repo",
    "--no-recursion",
    "--no-xattrs",
    "--no-acls",
    "--no-fflags",
    "--null",
    "-T",
    "-",
    "-cf",
    "-",
  ]);
});

test("tool result exposes output, failure, and unapplied patch", () => {
  const text = renderDrydockResult({
    stdout: "hello\n",
    stderr: "warning\n",
    exitCode: 7,
    patch: "--- a/file\n+++ b/file\n",
  });
  assert.match(text, /exit_code: 7/);
  assert.match(text, /stdout:\nhello/);
  assert.match(text, /stderr:\nwarning/);
  assert.match(text, /patch \(not applied\):/);
});
