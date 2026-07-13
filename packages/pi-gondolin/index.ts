/**
 * pi-gondolin — run pi's tools inside a hardened Gondolin micro-VM.
 *
 * What this adds over the upstream tool-routing example:
 *   - Locked egress: every outbound host is checked against an allowlist. Unknown
 *     hosts trigger an interactive prompt (allow once / allow & save / deny).
 *   - GitHub token injection host-side (guest sees only a placeholder).
 *   - Read-only skill mounts + system-prompt path rewriting so advertised skills
 *     resolve inside the VM.
 *   - HOME=/root and host-env sanitization (no leaked host home/identity).
 *   - git-worktree safety: shared .git mounted for linked worktrees, gc/prune
 *     refused, auto-gc disabled.
 *   - Your zsh + starship + modern-CLI dotfiles inside the guest.
 *   - Opt-in in-VM browser (chromium + agent-browser) via --gondolin-browser.
 *
 * Usage:  pi -e /path/to/agent-tools/packages/pi-gondolin
 *         (or symlink it into ~/.pi/agent/extensions/ via scripts/install.sh)
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { listImageRefs, VM } from "@earendil-works/gondolin";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AllowList, type Decision } from "./src/allowlist.ts";
import { buildHttpGate } from "./src/http-gate.ts";
import { buildMountPlan, rewriteHostPaths } from "./src/mounts.ts";
import { GUEST_WORKSPACE } from "./src/paths.ts";
import { guestEnv, provisionGuest } from "./src/provision.ts";
import { Telemetry } from "./src/telemetry.ts";
import {
	createGondolinBashOps,
	createGondolinEditOps,
	createGondolinFindOps,
	createGondolinLsOps,
	createGondolinReadOps,
	createGondolinWriteOps,
	executeGondolinGrep,
} from "./src/tools.ts";

const ENABLE_FLAG = "gondolin";
const BROWSER_FLAG = "gondolin-browser";

/** Resolve a GitHub token host-side for injection (never exposed to the guest). */
function resolveGithubToken(): string | undefined {
	const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	try {
		const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();

	// Register flags so pi accepts them. Flag *values* aren't populated until after
	// this factory runs, so the opt-in decision below reads argv/env directly.
	pi.registerFlag(ENABLE_FLAG, {
		type: "boolean",
		default: false,
		description:
			"Run pi's file/shell tools inside a Gondolin micro-VM sandbox (locked egress + interactive allowlist).",
	});
	pi.registerFlag(BROWSER_FLAG, {
		type: "boolean",
		default: false,
		description: "With --gondolin: provision an in-VM browser (chromium + agent-browser). Heavier boot.",
	});

	// OPT-IN: the sandbox is OFF by default. Enable per-launch with `pi --gondolin`
	// (or `GONDOLIN=1 pi`). When off, we register nothing that alters pi — no VM, no
	// tool routing, no system-prompt changes — so pi behaves exactly as without us.
	const enabled =
		process.env.GONDOLIN === "1" ||
		process.env.GONDOLIN_BROWSER === "1" ||
		process.argv.includes(`--${ENABLE_FLAG}`) ||
		process.argv.includes(`--${BROWSER_FLAG}`);

	if (!enabled) {
		pi.registerCommand("gondolin", {
			description: "Gondolin sandbox status (OFF — opt-in)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					"Gondolin sandbox is OFF (opt-in). Relaunch with `pi --gondolin` (or `GONDOLIN=1 pi`) to run " +
						"pi's file/shell tools inside the micro-VM with locked egress + your dotfiles. " +
						"Add `--gondolin-browser` for the in-VM browser.",
					"info",
				);
			},
		});
		return;
	}

	// ---- ENABLED: full sandbox below -------------------------------------------

	// Boot telemetry: ms since `pi` was invoked. Mark as early as possible.
	const telemetry = new Telemetry(
		path.join(homedir(), ".pi/agent/gondolin/telemetry.jsonl"),
		process.env.GONDOLIN_TELEMETRY !== "0",
	);
	telemetry.mark("extension_loaded");

	// Allowlist store: committed defaults + user-saved additions.
	const allowList = new AllowList({
		defaultsPath: fileURLToPath(new URL("./config/allowlist.default.json", import.meta.url)),
		savedPath: path.join(homedir(), ".pi/agent/gondolin/allowlist.json"),
		log: (m) => console.error(`[gondolin-allowlist] ${m}`),
	});

	// Latest UI context, refreshed on every event so the egress prompter always
	// targets the live TUI.
	let currentUi: ExtensionUIContext | undefined;
	let currentHasUI = false;

	async function promptForHost(host: string, reason: string | undefined): Promise<Decision> {
		const ui = currentUi;
		if (!ui) throw new Error("no ui");
		const allowOnce = "Allow once (this session)";
		const allowSave = `Allow & save (${host})`;
		const deny = "Deny";
		const title = reason ? `Sandbox egress: ${host}  —  ${reason}` : `Allow sandbox egress to ${host}?`;
		const choice = await ui.select(title, [allowOnce, allowSave, deny]);
		if (choice === undefined) throw new Error("dismissed"); // non-sticky
		if (choice === allowOnce) return "allow-once";
		if (choice === allowSave) return "allow-save";
		return "deny";
	}

	function rememberCtx(ctx: ExtensionContext): void {
		currentUi = ctx.ui;
		currentHasUI = ctx.hasUI;
		// Only offer interactive approval when a dialog-capable UI exists; otherwise
		// the allowlist fails closed (see AllowList#decide).
		allowList.setPrompter(currentHasUI ? promptForHost : undefined);
	}

	const browserEnabled = (): boolean =>
		pi.getFlag(BROWSER_FLAG) === true || process.env.GONDOLIN_BROWSER === "1";

	/**
	 * Prefer a baked pi-gondolin image when one exists — the stock image's rootfs
	 * is too small for the full toolchain. Respects an explicit
	 * GONDOLIN_DEFAULT_IMAGE. Returns the image ref actually selected (or the
	 * stock default) for status display.
	 */
	function selectImage(browser: boolean): string {
		if (process.env.GONDOLIN_DEFAULT_IMAGE) return process.env.GONDOLIN_DEFAULT_IMAGE;
		try {
			const refs = new Set(listImageRefs().map((r) => r.reference));
			const preferred = browser
				? ["pi-gondolin-browser:latest", "pi-gondolin:latest"]
				: ["pi-gondolin:latest"];
			for (const ref of preferred) {
				if (refs.has(ref)) {
					process.env.GONDOLIN_DEFAULT_IMAGE = ref;
					return ref;
				}
			}
		} catch {
			// image store unreadable; fall through to the stock default
		}
		return process.env.GONDOLIN_DEFAULT_IMAGE ?? "alpine-base:latest (stock)";
	}

	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	let shellPath = "/bin/bash";
	let mountSummary: string[] = [];
	let tokenWired = false;
	let imageRef = "alpine-base:latest (stock)";

	async function startVm(ctx?: ExtensionContext): Promise<VM> {
		const browser = browserEnabled();
		telemetry.mark("vm_boot_start");
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", "Gondolin: booting"));

		imageRef = selectImage(browser);
		const stockImage = !process.env.GONDOLIN_DEFAULT_IMAGE;

		const plan = buildMountPlan(localCwd);
		mountSummary = plan.summary;

		const gate = buildHttpGate(allowList, resolveGithubToken());
		tokenWired = gate.githubTokenWired;

		const created = await VM.create({
			sessionLabel: `pi ${path.basename(localCwd)}${browser ? " +browser" : ""}`,
			vfs: { mounts: plan.mounts },
			// Secret placeholders (GITHUB_TOKEN=...) merged over the base guest env.
			env: { ...guestEnv({ browser }), ...gate.env },
			httpHooks: gate.httpHooks,
			memory: browser ? "6G" : "4G",
			cpus: browser ? 4 : 2,
		});
		telemetry.mark("vm_created");

		// Provision after boot (bash may not exist until apk runs).
		ctx?.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("accent", `Gondolin: provisioning${browser ? " (+browser)" : ""}`),
		);
		const provision = await provisionGuest(created, {
			browser,
			log: (m) => console.error(`[gondolin-provision] ${m}`),
		});
		telemetry.mark("provisioned");
		shellPath = provision.shellPath;

		vm = created;
		telemetry.mark("vm_ready");
		telemetry.flushBoot({ image: imageRef, browser, tokenWired, stockImage });
		ctx?.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("accent", `Gondolin ${created.id.slice(0, 8)}${browser ? " +browser" : ""}`),
		);
		ctx?.ui.notify(
			[
				`Gondolin VM ready in ${telemetry.between("vm_boot_start", "vm_ready") ?? "?"}ms (${telemetry.totalMs()}ms since pi start).`,
				`${localCwd} mounted at ${GUEST_WORKSPACE}.`,
				`Egress is locked to an allowlist (${tokenWired ? "GitHub token wired" : "no GitHub token found"}).`,
				`Image: ${imageRef}.`,
				stockImage
					? "Stock image: only a minimal toolset is installed. Run scripts/build-image.sh for the full zsh/starship experience."
					: "",
				browser ? "Browser profile active." : "",
			]
				.filter(Boolean)
				.join(" "),
			"info",
		);
		return created;
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (vm) return vm;
		if (!vmStarting) {
			vmStarting = startVm(ctx).finally(() => {
				vmStarting = undefined;
			});
		}
		return vmStarting;
	}

	// ---- lifecycle -----------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// ≈ the moment pi has started the interactive session (rendered the prompt).
		telemetry.mark("session_start");
		rememberCtx(ctx);
		// Boot the VM in the BACKGROUND. The inherent first-exec/guest-readiness
		// warmup (~0.6–2.7s) must not block the prompt from rendering — the routed
		// tools already `await ensureVm(...)`, so they wait for readiness only when
		// first used, by which point boot is usually done.
		void ensureVm(ctx).catch((error) => {
			ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("error", "Gondolin: boot failed"));
			ctx.ui.notify(`Gondolin failed to start: ${(error as Error).message}`, "error");
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const activeVm = vm;
		vm = undefined;
		vmStarting = undefined;
		if (!activeVm) return;
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
		try {
			await activeVm.close();
		} finally {
			ctx.ui.setStatus("gondolin", undefined);
		}
	});

	// ---- interactive network-access tool ------------------------------------
	pi.registerTool({
		name: "request_network_access",
		label: "Request network access",
		description:
			"Ask the user to allow the sandbox VM to reach one or more network hosts (adds them to " +
			"the egress allowlist). Use this proactively before running a command that needs a host " +
			"that is not already allowed — e.g. a package registry, an API, or a website to browse. " +
			"The user chooses allow-once, allow-and-save, or deny. Note: any blocked outbound " +
			"connection also prompts the user automatically, so you may simply retry after asking.",
		promptSnippet:
			"request_network_access(hosts, reason) — ask the user to allow sandbox egress to hosts",
		parameters: Type.Object({
			hosts: Type.Array(Type.String(), {
				description: 'Hostnames to allow, e.g. ["example.com", "api.example.com"]. No scheme or path.',
			}),
			reason: Type.String({ description: "Why the sandbox needs to reach these hosts." }),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			rememberCtx(ctx);
			const hosts = params.hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
			if (hosts.length === 0) {
				return { content: [{ type: "text", text: "No hosts specified." }], details: undefined, isError: true };
			}
			if (!ctx.hasUI) {
				return {
					content: [
						{ type: "text", text: `No interactive UI available to approve access to ${hosts.join(", ")}; denied.` },
					],
					details: undefined,
					isError: true,
				};
			}
			const allowOnce = "Allow once (this session)";
			const allowSave = "Allow & save";
			const deny = "Deny";
			const choice = await ctx.ui.select(
				`Agent requests network access to: ${hosts.join(", ")}  —  ${params.reason}`,
				[allowOnce, allowSave, deny],
			);
			if (choice === deny || choice === undefined) {
				return {
					content: [{ type: "text", text: `Denied network access to: ${hosts.join(", ")}.` }],
					details: undefined,
				};
			}
			const persist = choice === allowSave;
			for (const host of hosts) allowList.add(host, persist);
			return {
				content: [
					{
						type: "text",
						text: `Allowed${persist ? " and saved" : " for this session"}: ${hosts.join(", ")}.`,
					},
				],
				details: undefined,
			};
		},
	});

	// ---- routed file/shell tools ---------------------------------------------
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			rememberCtx(ctx);
			const activeVm = await ensureVm(ctx);
			const tool = createReadTool(GUEST_WORKSPACE, { operations: createGondolinReadOps(activeVm, localCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			rememberCtx(ctx);
			const activeVm = await ensureVm(ctx);
			const tool = createWriteTool(GUEST_WORKSPACE, { operations: createGondolinWriteOps(activeVm, localCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			rememberCtx(ctx);
			const activeVm = await ensureVm(ctx);
			const tool = createEditTool(GUEST_WORKSPACE, { operations: createGondolinEditOps(activeVm, localCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			rememberCtx(ctx);
			const activeVm = await ensureVm(ctx);
			const tool = createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(activeVm, localCwd, shellPath),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			rememberCtx(ctx);
			const activeVm = await ensureVm(ctx);
			const tool = createLsTool(GUEST_WORKSPACE, { operations: createGondolinLsOps(activeVm, localCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			rememberCtx(ctx);
			const activeVm = await ensureVm(ctx);
			const tool = createFindTool(GUEST_WORKSPACE, { operations: createGondolinFindOps(activeVm, localCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			rememberCtx(ctx);
			const activeVm = await ensureVm(ctx);
			return executeGondolinGrep(activeVm, localCwd, params, signal);
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		rememberCtx(ctx);
		const activeVm = await ensureVm(ctx);
		return { operations: createGondolinBashOps(activeVm, localCwd, shellPath) };
	});

	// ---- commands ------------------------------------------------------------
	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM + sandbox status",
		handler: async (_args, ctx) => {
			rememberCtx(ctx);
			const activeVm = await ensureVm(ctx);
			const pats = allowList.patterns();
			ctx.ui.notify(
				[
					`Gondolin VM: ${activeVm.id}`,
					`Image: ${imageRef}`,
					`Boot: ${telemetry.between("vm_boot_start", "vm_ready") ?? "?"}ms VM, ${telemetry.totalMs()}ms since pi start`,
					`Workspace: ${localCwd} -> ${GUEST_WORKSPACE}`,
					`Shell: ${shellPath}`,
					`Browser: ${browserEnabled() ? "on" : "off"}`,
					`GitHub token: ${tokenWired ? "wired" : "not found"}`,
					`Allowlist: ${pats.defaults.length} default, ${pats.saved.length} saved, ${pats.session.length} session`,
					"",
					"Mounts:",
					...mountSummary.map((s) => `  ${s}`),
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("gondolin-timing", {
		description: "Show the sandbox boot timeline (ms since pi started)",
		handler: async (_args, ctx) => {
			const render = telemetry.between("extension_loaded", "session_start");
			const vmBoot = telemetry.between("vm_boot_start", "vm_ready");
			ctx.ui.notify(
				[
					"Gondolin boot timeline (ms since pi invoked):",
					telemetry.format() || "  (no marks yet)",
					"",
					`Ext→session (≈render): ${render ?? "?"}ms   VM boot: ${vmBoot ?? "?"}ms   Total to ready: ${telemetry.totalMs()}ms`,
					`Log: ${path.join(homedir(), ".pi/agent/gondolin/telemetry.jsonl")}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("gondolin-allowlist", {
		description: "Show the current egress allowlist",
		handler: async (_args, ctx) => {
			const pats = allowList.patterns();
			ctx.ui.notify(
				[
					"Egress allowlist:",
					`  defaults (${pats.defaults.length}): ${pats.defaults.join(", ")}`,
					`  saved (${pats.saved.length}): ${pats.saved.join(", ") || "—"}`,
					`  session (${pats.session.length}): ${pats.session.join(", ") || "—"}`,
					"",
					"Add: /gondolin-allow <host>    Remove saved: /gondolin-unallow <host>",
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("gondolin-allow", {
		description: "Add a host pattern to the saved egress allowlist",
		handler: async (args, ctx) => {
			let hosts = args.trim();
			if (!hosts) hosts = (await ctx.ui.input("Host to allow (e.g. example.com or *.example.com)")) ?? "";
			const list = hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
			if (list.length === 0) {
				ctx.ui.notify("No host given.", "warning");
				return;
			}
			for (const h of list) allowList.add(h, true);
			ctx.ui.notify(`Allowed + saved: ${list.join(", ")}`, "info");
		},
	});

	pi.registerCommand("gondolin-unallow", {
		description: "Remove a host pattern from the saved egress allowlist",
		handler: async (args, ctx) => {
			const list = args.trim().split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
			if (list.length === 0) {
				ctx.ui.notify("Usage: /gondolin-unallow <host>", "warning");
				return;
			}
			for (const h of list) allowList.remove(h);
			ctx.ui.notify(`Removed: ${list.join(", ")}`, "info");
		},
	});

	// ---- system-prompt rewriting ---------------------------------------------
	pi.on("before_agent_start", async (event, ctx) => {
		rememberCtx(ctx);
		if (!telemetry.has("first_prompt")) {
			telemetry.mark("first_prompt");
			telemetry.event("first_prompt", { sincePiStartMs: telemetry.totalMs() });
		}
		// Ensure boot is underway but DON'T block the turn on it — the system-prompt
		// rewrite below is host-side, and the routed tools await readiness lazily.
		void ensureVm(ctx).catch(() => {});
		const plan = buildMountPlan(localCwd);

		// Rewrite advertised host paths (cwd, shared .git, home) into guest paths.
		let systemPrompt = rewriteHostPaths(event.systemPrompt, plan.rewrites);

		// Make the working-directory line unambiguous.
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
		systemPrompt = systemPrompt.includes(localLine)
			? systemPrompt.replace(localLine, guestLine)
			: systemPrompt;

		// Describe the sandbox so the agent behaves well within it.
		const preamble = [
			"",
			"## Sandbox (Gondolin)",
			`Your file and shell tools run inside a Gondolin micro-VM. The host working directory is mounted read-write at ${GUEST_WORKSPACE}; changes there write through to the host. Other guest filesystem changes are ephemeral.`,
			"Network egress is locked to an allowlist. If a command needs a host that is not yet allowed, the user is prompted automatically to allow or deny it — you can also call `request_network_access(hosts, reason)` to ask before running the command.",
			"Do not run `git gc`, `git prune`, or `git worktree prune/remove` — they are refused because the host repo's worktree metadata is shared.",
			"Skills, git, ripgrep, and your usual modern CLI tools are available inside the VM.",
		].join("\n");

		return { systemPrompt: `${systemPrompt}\n${preamble}` };
	});
}
