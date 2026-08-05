import * as fs from "node:fs";
import * as path from "node:path";
import { getTeamsRootDir } from "./paths.js";
import { assessAttachClaimFreshness, readTeamAttachClaim } from "./team-attach-claim.js";
import { loadTeamConfig } from "./team-config.js";
import type { TeamsStyle } from "./teams-style.js";

export interface DiscoveredTeam {
	teamId: string;
	teamDir: string;
	taskListId: string;
	leadName: string;
	style: TeamsStyle;
	workerCount: number;
	onlineWorkerCount: number;
	updatedAt: string;
	attachedBySessionId?: string;
	attachClaimStale?: boolean;
	attachHeartbeatAt?: string;
}

export async function listDiscoveredTeams(teamsRoot = getTeamsRootDir()): Promise<DiscoveredTeam[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(teamsRoot, { withFileTypes: true });
	} catch {
		return [];
	}

	const out: DiscoveredTeam[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		if (e.name.startsWith("_")) continue;
		const teamDir = path.join(teamsRoot, e.name);
		const cfg = await loadTeamConfig(teamDir);
		if (!cfg) continue;

		const workers = cfg.members.filter((m) => m.role === "worker");
		const onlineWorkerCount = workers.filter((m) => m.status === "online").length;
		const attachClaim = await readTeamAttachClaim(teamDir);
		const freshness = attachClaim ? assessAttachClaimFreshness(attachClaim) : null;
		out.push({
			teamId: cfg.teamId,
			teamDir,
			taskListId: cfg.taskListId,
			leadName: cfg.leadName,
			style: cfg.style ?? "normal",
			workerCount: workers.length,
			onlineWorkerCount,
			updatedAt: cfg.updatedAt,
			attachedBySessionId: attachClaim?.holderSessionId,
			attachClaimStale: freshness?.isStale,
			attachHeartbeatAt: attachClaim?.heartbeatAt,
		});
	}

	out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
	return out;
}
