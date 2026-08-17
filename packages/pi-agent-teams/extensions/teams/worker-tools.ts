const TEAMMATE_BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const TEAM_CONTROL_TOOLS = ["team_message", "team_task_result"];
const READONLY_DENIED_TOOLS = new Set(["bash", "edit", "write"]);

export interface WorkerToolPolicy {
	tools: string[];
	args: string[];
	warnings: string[];
}

export function resolveWorkerToolPolicy(options: {
	activeTools: readonly string[];
	requestedTools?: readonly string[];
	readonly?: boolean;
}): WorkerToolPolicy {
	const activeBuiltins = options.activeTools.filter((tool) => TEAMMATE_BUILTIN_TOOLS.has(tool));
	const requested = options.requestedTools ?? activeBuiltins;
	const tools = requested.filter(
		(tool) =>
			TEAMMATE_BUILTIN_TOOLS.has(tool) &&
			activeBuiltins.includes(tool) &&
			!(options.readonly && READONLY_DENIED_TOOLS.has(tool)),
	);
	const warnings = requested
		.filter(
			(tool) =>
				!TEAM_CONTROL_TOOLS.includes(tool) &&
				!tools.includes(tool) &&
				!(options.readonly && READONLY_DENIED_TOOLS.has(tool)),
		)
		.map((tool) => `Agent tool unavailable to teammate: ${tool}`);
	const args = tools.length > 0
		? ["--tools", [...tools, ...TEAM_CONTROL_TOOLS].join(",")]
		: ["--no-builtin-tools"];
	return { tools, args, warnings };
}
