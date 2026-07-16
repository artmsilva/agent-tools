import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SHORTCUT = "alt+z";
const STATUS_KEY = "open-zed";

async function worktreeRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		timeout: 2_000,
	});
	const root = result.stdout.trim();
	return result.code === 0 && root ? root : cwd;
}

async function openInZed(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const path = await worktreeRoot(pi, ctx.cwd);
	const result = await pi.exec("zed", [path], { cwd: path, timeout: 5_000 });

	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		ctx.ui.notify(`Could not open Zed: ${reason}`, "error");
		return;
	}

	ctx.ui.notify(`Opened ${path} in Zed`, "info");
}

export default function openZedExtension(pi: ExtensionAPI) {
	pi.registerCommand("zed", {
		description: "Open the current git worktree in Zed",
		handler: async (_args, ctx) => openInZed(pi, ctx),
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the current git worktree in Zed",
		handler: async (ctx) => openInZed(pi, ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const hint = ctx.ui.theme.fg("accent", "⌥Z");
		const label = ctx.ui.theme.fg("dim", "Open in Zed");
		ctx.ui.setStatus(STATUS_KEY, `${hint} ${label}`);
	});
}
