import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const actions = [
	"view",
	"init",
	"add",
	"checkout",
	"bottom",
	"down",
	"up",
	"top",
	"trunk",
	"submit",
	"sync",
	"rebase",
	"push",
	"link",
	"merge",
	"unstack",
] as const;

const Params = Type.Object({
	action: StringEnum(actions),
	target: Type.Optional(Type.String({ description: "Branch, PR number/URL, or stack number, depending on the action." })),
	targets: Type.Optional(Type.Array(Type.String(), { description: "Ordered bottom-to-top branches or PRs for init/link." })),
	base: Type.Optional(Type.String({ description: "Trunk/base branch for init or link." })),
	message: Type.Optional(Type.String({ description: "Commit message for add." })),
	stage: Type.Optional(StringEnum(["all", "tracked"] as const)),
	open: Type.Optional(Type.Boolean({ description: "Mark submitted/linked PRs ready for review. Otherwise new submitted PRs are drafts." })),
	remote: Type.Optional(Type.String()),
	prune: Type.Optional(Type.Boolean({ description: "For sync: delete local branches for merged PRs." })),
	steps: Type.Optional(Type.Integer({ minimum: 1, description: "Number of layers for up/down. Defaults to 1." })),
	direction: Type.Optional(StringEnum(["upstack", "downstack"] as const)),
	noTrunk: Type.Optional(Type.Boolean({ description: "For rebase: only rebase stack branches onto each other." })),
	continue: Type.Optional(Type.Boolean({ description: "Continue an interrupted rebase." })),
	abort: Type.Optional(Type.Boolean({ description: "Abort an interrupted rebase and restore branches." })),
	preserveDates: Type.Optional(Type.Boolean({ description: "Preserve author dates during rebase." })),
	mergeMethod: Type.Optional(StringEnum(["merge", "squash", "rebase"] as const)),
	localOnly: Type.Optional(Type.Boolean({ description: "For unstack: remove local tracking only." })),
});

type ParamsT = Static<typeof Params>;

export function buildStackArgs(params: ParamsT): string[] {
	const args = ["stack", params.action];
	const addRemote = () => {
		if (params.remote) args.push("--remote", params.remote);
	};

	switch (params.action) {
		case "view":
			args.push("--json");
			break;
		case "init":
			if (!params.targets?.length) throw new Error("at least one bottom-to-top branch is required for init");
			if (params.base) args.push("--base", params.base);
			args.push(...params.targets);
			break;
		case "add":
			if (!params.target && !params.message) throw new Error("target or message is required for add");
			if (params.stage && !params.message) throw new Error("message is required when stage is set so gh stack add cannot open an editor");
			if (params.target) args.push(params.target);
			if (params.stage === "all") args.push("--all");
			if (params.stage === "tracked") args.push("--update");
			if (params.message) args.push("--message", params.message);
			break;
		case "checkout":
			if (!params.target) throw new Error("target is required for checkout so gh stack cannot open an interactive picker");
			args.push(params.target);
			break;
		case "down":
		case "up":
			if (params.steps) args.push(String(params.steps));
			break;
		case "submit":
			args.push("--auto");
			if (params.open) args.push("--open");
			addRemote();
			break;
		case "sync":
			if (params.prune) args.push("--prune");
			addRemote();
			break;
		case "rebase":
			if (params.continue && params.abort) throw new Error("continue and abort are mutually exclusive");
			if (params.target) args.push(params.target);
			if (params.direction) args.push(`--${params.direction}`);
			if (params.noTrunk) args.push("--no-trunk");
			if (params.continue) args.push("--continue");
			if (params.abort) args.push("--abort");
			if (params.preserveDates) args.push("--preserve-dates");
			addRemote();
			break;
		case "push":
			addRemote();
			break;
		case "link":
			if ((params.targets?.length ?? 0) < 2) throw new Error("at least two bottom-to-top targets are required for link");
			args.push(...params.targets!);
			if (params.base) args.push("--base", params.base);
			if (params.open) args.push("--open");
			addRemote();
			break;
		case "merge":
			if (!params.mergeMethod) throw new Error("mergeMethod is required for a non-interactive stack merge");
			if (params.target) args.push(params.target);
			args.push("--yes", `--${params.mergeMethod}`);
			break;
		case "unstack":
			if (params.target) args.push(params.target);
			if (params.localOnly) args.push("--local");
			break;
	}

	return args;
}

export default function ghStackExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "gh_stack",
		label: "GitHub stacked PRs",
		description:
			"Structured gh-stack operations for dependent pull requests. Supports creating, viewing, submitting, syncing, rebasing, linking, navigating, merging, and unstacking stacks. gh-stack is a GitHub public preview extension and must be installed.",
		promptSnippet: "Create and manage stacked pull requests with the gh stack extension.",
		promptGuidelines: [
			"Use gh_stack for two or more dependent, independently reviewable PR layers; use gh_pr for a standalone PR.",
			"Pass init/link targets in bottom-to-top order. submit uses non-interactive --auto and creates drafts unless open=true; use gh_pr create per layer then link when custom titles/bodies are required.",
			"After changing a lower layer, use rebase then push so upper layers inherit the fix.",
			"Only submit, sync, push, link, merge, or unstack when the user explicitly requested the corresponding GitHub change.",
		],
		parameters: Params,
		async execute(_id, params: ParamsT, _signal, _onUpdate, ctx) {
			const args = buildStackArgs(params);
			const result = await pi.exec("gh", args, {
				cwd: ctx.cwd,
				signal: ctx.signal,
				timeout: 120_000,
			});
			const text = result.stdout.trim() || result.stderr.trim() || "(no output)";
			if (result.code !== 0) throw new Error(text);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					command: ["gh", ...args],
					actionClass: params.action === "view" ? "read" : ["init", "add", "checkout", "bottom", "down", "up", "top", "trunk", "rebase"].includes(params.action) ? "local_mutation" : "github_mutation",
				},
			};
		},
	});
}
