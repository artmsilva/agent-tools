import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HerdrClient } from "../extensions/teams/herdr-client.js";

function paneStatus(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const result = (value as Record<string, unknown>).result;
	if (typeof result !== "object" || result === null) return undefined;
	const pane = (result as Record<string, unknown>).pane;
	if (typeof pane !== "object" || pane === null) return undefined;
	const status = (pane as Record<string, unknown>).agent_status;
	return typeof status === "string" ? status : undefined;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionEntry = path.join(packageRoot, "extensions", "teams", "index.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-herdr-integration-"));
const teamDir = path.join(root, "team-e2e");
const client = new HerdrClient();
let launched: Awaited<ReturnType<HerdrClient["launch"]>> | undefined;

try {
	if (!(await client.isAvailable())) throw new Error("Herdr server is unavailable");
	launched = await client.launch({
		name: "e2e",
		cwd: packageRoot,
		teamDir,
		teamId: "team-e2e",
		env: {
			PI_TEAMS_WORKER: "1",
			PI_TEAMS_TEAM_ID: "team-e2e",
			PI_TEAMS_TASK_LIST_ID: "team-e2e",
			PI_TEAMS_AGENT_NAME: "e2e",
			PI_TEAMS_LEAD_NAME: "team-lead",
			PI_TEAMS_AUTO_CLAIM: "0",
			PI_TEAMS_ROOT_DIR: root,
		},
		args: ["--no-session", "--no-extensions", "-e", extensionEntry],
	});
	await client.message(launched.agentName, "/name pi-agent-teams-herdr-e2e");
	const status = paneStatus(await client.paneState(launched.paneId));
	if (status !== "idle") throw new Error(`Expected idle Herdr worker, got ${status ?? "unknown"}`);
	console.log(`Herdr integration passed: ${launched.workspaceId}/${launched.paneId}`);
} finally {
	if (launched) await client.close(teamDir, "e2e", launched.paneId);
	fs.rmSync(root, { recursive: true, force: true });
}
