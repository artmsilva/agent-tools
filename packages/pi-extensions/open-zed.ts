import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, dirname, resolve } from "node:path";

const SHORTCUT = "alt+z";
const STATUS_KEY = "open-zed";
const TARGET_ENTRY = "open-zed.target";

type FooterSlot = { setText(text: string): void };
let footerSlot: Promise<FooterSlot | undefined> | undefined;

function getFooterSlot(): Promise<FooterSlot | undefined> {
	return (footerSlot ??= import("@zigai/pi-footer/api")
		.then(({ registerFooterSlot }) =>
			registerFooterSlot({ id: "open-zed.status", defaultSide: "left" }),
		)
		.catch(() => undefined));
}

async function worktreeRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		timeout: 2_000,
	});
	const root = result.stdout.trim();
	return result.code === 0 && root ? root : cwd;
}

function directoryFromBash(command: string, cwd: string): string | undefined {
	const match = command.match(/^\s*cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
	const path = match?.[1] ?? match?.[2] ?? match?.[3];
	return path ? resolve(cwd, path.replace(/\\(.)/g, "$1")) : undefined;
}

function restoredDirectory(ctx: ExtensionContext): string | undefined {
	const pendingDirectories = new Map<string, string>();
	let recordedDirectory: string | undefined;
	let latestBashDirectory: string | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === TARGET_ENTRY) {
			const data = entry.data;
			if (data && typeof data === "object" && "directory" in data && typeof data.directory === "string") {
				recordedDirectory = data.directory;
			}
			continue;
		}
		if (entry.type !== "message") continue;

		if (entry.message.role === "assistant") {
			for (const content of entry.message.content) {
				if (content.type !== "toolCall" || content.name !== "bash") continue;
				const command = content.arguments.command;
				if (typeof command === "string") {
					const target = directoryFromBash(command, ctx.cwd);
					if (target) pendingDirectories.set(content.id, target);
				}
			}
		} else if (entry.message.role === "toolResult") {
			const target = pendingDirectories.get(entry.message.toolCallId);
			pendingDirectories.delete(entry.message.toolCallId);
			if (target && !entry.message.isError) latestBashDirectory = target;
		}
	}
	return recordedDirectory ?? latestBashDirectory;
}

async function zedTarget(pi: ExtensionAPI, cwd: string): Promise<string> {
	return worktreeRoot(pi, cwd);
}

async function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<void> {
	if (ctx.mode !== "tui") return;
	const path = await zedTarget(pi, cwd);
	const text = `⌥Z Open ${basename(path)} in Zed`;
	const hint = ctx.ui.theme.fg("accent", "⌥Z");
	const label = ctx.ui.theme.fg("dim", `Open ${basename(path)} in Zed`);
	ctx.ui.setStatus(STATUS_KEY, `${hint} ${label}`);
	(await getFooterSlot())?.setText(text);
}

async function openInZed(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string): Promise<void> {
	const path = await zedTarget(pi, cwd);
	const result = await pi.exec("zed", ["--new", path], { cwd: path, timeout: 5_000 });

	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		ctx.ui.notify(`Could not open Zed: ${reason}`, "error");
		return;
	}

	ctx.ui.notify(`Opened ${path} in Zed`, "info");
}

export default function openZedExtension(pi: ExtensionAPI) {
	const pendingDirectories = new Map<string, string>();
	let recentlyUsedDirectory: string | undefined;

	pi.on("tool_call", (event, ctx) => {
		const editedPath = event.toolName === "write" || event.toolName === "edit" ? event.input.path : undefined;
		const bashDirectory = event.toolName === "bash" ? directoryFromBash(String(event.input.command ?? ""), ctx.cwd) : undefined;
		const directory = typeof editedPath === "string" ? dirname(resolve(ctx.cwd, editedPath)) : bashDirectory;
		if (directory) pendingDirectories.set(event.toolCallId, directory);
	});

	pi.on("tool_result", async (event, ctx) => {
		const directory = pendingDirectories.get(event.toolCallId);
		if (!directory) return;
		pendingDirectories.delete(event.toolCallId);
		if (event.isError) return;
		if (recentlyUsedDirectory !== directory) {
			recentlyUsedDirectory = directory;
			pi.appendEntry(TARGET_ENTRY, { directory });
		}
		await updateStatus(pi, ctx, directory);
	});

	pi.registerCommand("zed", {
		description: "Open the most recently used git worktree in Zed",
		handler: async (_args, ctx) => openInZed(pi, ctx, recentlyUsedDirectory ?? ctx.cwd),
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the most recently used git worktree in Zed",
		handler: async (ctx) => openInZed(pi, ctx, recentlyUsedDirectory ?? ctx.cwd),
	});

	pi.on("session_start", async (_event, ctx) => {
		pendingDirectories.clear();
		recentlyUsedDirectory = restoredDirectory(ctx) ?? ctx.cwd;
		await updateStatus(pi, ctx, recentlyUsedDirectory);
	});
}
