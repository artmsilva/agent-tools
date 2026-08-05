import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getInboxPath, popUnreadMessages, writeToMailbox } from "./mailbox.js";

function mailboxFixture(t: { after(fn: () => void): void }): string {
	const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-mailbox-"));
	t.after(() => fs.rmSync(teamDir, { recursive: true, force: true }));
	return teamDir;
}

test("concurrent mailbox writers preserve every message", async (t) => {
	const teamDir = mailboxFixture(t);
	await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			writeToMailbox(teamDir, "team", "worker", {
				from: "lead",
				text: `message-${index}`,
				timestamp: new Date(index).toISOString(),
			}),
		),
	);
	const messages = await popUnreadMessages(teamDir, "team", "worker");
	assert.equal(messages.length, 20);
	assert.deepEqual(new Set(messages.map((message) => message.text)).size, 20);
});

test("concurrent readers deliver each unread message exactly once", async (t) => {
	const teamDir = mailboxFixture(t);
	for (let index = 0; index < 10; index += 1) {
		await writeToMailbox(teamDir, "team", "worker", {
			from: "lead",
			text: `message-${index}`,
			timestamp: new Date(index).toISOString(),
		});
	}
	const batches = await Promise.all(
		Array.from({ length: 5 }, () => popUnreadMessages(teamDir, "team", "worker")),
	);
	assert.equal(batches.flat().length, 10);
	assert.deepEqual(await popUnreadMessages(teamDir, "team", "worker"), []);
});

test("malformed inbox content is recovered on the next write", async (t) => {
	const teamDir = mailboxFixture(t);
	const inbox = getInboxPath(teamDir, "team", "worker");
	fs.mkdirSync(path.dirname(inbox), { recursive: true });
	fs.writeFileSync(inbox, "not-json");
	await writeToMailbox(teamDir, "team", "worker", {
		from: "lead",
		text: "recovered",
		timestamp: new Date(0).toISOString(),
	});
	assert.deepEqual((await popUnreadMessages(teamDir, "team", "worker")).map((message) => message.text), ["recovered"]);
});
