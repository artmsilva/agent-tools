import assert from "node:assert/strict";
import { test } from "node:test";
import { assertValidTeamId } from "./paths.js";

test("team ids accept session-style identifiers", () => {
	assert.equal(assertValidTeamId("019fc75d-01db-7a35-8aca-5f025ef626d1"), "019fc75d-01db-7a35-8aca-5f025ef626d1");
	assert.equal(assertValidTeamId("release_team-2"), "release_team-2");
});

test("team ids reject path traversal and separators", () => {
	for (const value of ["", ".", "..", "../other", "a/b", "a\\b", "/tmp/team"]) {
		assert.throws(() => assertValidTeamId(value), /Invalid team id/);
	}
});
