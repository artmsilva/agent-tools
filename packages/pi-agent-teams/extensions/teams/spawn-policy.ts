import type { WorkspaceMode } from "./spawn-types.js";

const DEFAULT_MAX_WORKERS = 6;
const HARD_MAX_WORKERS = 8;
const DEFAULT_MEMBER_STALE_MS = 30_000;

export function getMaxTeamWorkers(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env.PI_TEAMS_MAX_WORKERS ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_WORKERS;
	return Math.min(parsed, HARD_MAX_WORKERS);
}

export function getDefaultWorkspaceMode(env: NodeJS.ProcessEnv = process.env): WorkspaceMode {
	return env.PI_TEAMS_DEFAULT_WORKSPACE === "shared" ? "shared" : "worktree";
}

export function getTeamMemberStaleMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env.PI_TEAMS_MEMBER_STALE_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_MEMBER_STALE_MS;
}

export function isFreshOnlineMember(
	member: { status: string; lastSeenAt?: string },
	now = Date.now(),
	staleMs = getTeamMemberStaleMs(),
): boolean {
	if (member.status !== "online") return false;
	if (!member.lastSeenAt) return true;
	const lastSeenAt = Date.parse(member.lastSeenAt);
	return Number.isFinite(lastSeenAt) && now - lastSeenAt <= staleMs;
}
