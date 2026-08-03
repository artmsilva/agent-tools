import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { withLock } from "./fs-lock.js";

function lockFixture(t: { after(fn: () => void): void }): { dir: string; lock: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-lock-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return { dir, lock: path.join(dir, "state.lock") };
}

test("stale lock with a dead owner is reclaimed", async (t) => {
	const { lock } = lockFixture(t);
	fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, createdAt: new Date(0).toISOString() }));
	const result = await withLock(lock, async () => "acquired", { timeoutMs: 500, pollMs: 5 });
	assert.equal(result, "acquired");
	assert.equal(fs.existsSync(lock), false);
});

test("an old lock owned by the current process is never stolen", async (t) => {
	const { lock } = lockFixture(t);
	fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date(0).toISOString() }));
	const old = new Date(0);
	fs.utimesSync(lock, old, old);
	await assert.rejects(
		withLock(lock, async () => undefined, { timeoutMs: 80, pollMs: 5, staleMs: 1 }),
		/Timeout acquiring lock/,
	);
});
